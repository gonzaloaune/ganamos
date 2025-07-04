"use server"

import { createServerSupabaseClient } from "@/lib/supabase"
import { createInvoice, checkInvoice, payInvoice } from "@/lib/lightning"
import { revalidatePath } from "next/cache"

// Dynamic import for cookies to avoid issues with pages directory
async function getCookieStore() {
  const { cookies } = await import("next/headers")
  return cookies()
}

/**
 * Check if the Lightning configuration is valid
 */
async function checkLightningConfig() {
  const LND_REST_URL = process.env.LND_REST_URL
  const LND_ADMIN_MACAROON = process.env.LND_ADMIN_MACAROON

  if (!LND_REST_URL || !LND_ADMIN_MACAROON) {
    console.error("Lightning configuration missing")
    return {
      valid: false,
      error: "Lightning configuration missing",
      details: {
        url: LND_REST_URL ? "Set" : "Missing",
        macaroon: LND_ADMIN_MACAROON ? "Set" : "Missing",
      },
    }
  }

  // Check if URL is valid
  try {
    // Make sure URL has a protocol
    let urlToCheck = LND_REST_URL
    if (!urlToCheck.startsWith("http://") && !urlToCheck.startsWith("https://")) {
      urlToCheck = `https://${urlToCheck}`
    }

    new URL(urlToCheck)
  } catch (error) {
    return {
      valid: false,
      error: "Invalid Lightning URL format",
      details: `URL: "${LND_REST_URL}" - ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Check if macaroon is valid hex
  if (!/^[0-9a-fA-F]+$/.test(LND_ADMIN_MACAROON)) {
    return {
      valid: false,
      error: "Invalid macaroon format (should be hex)",
      details: `Macaroon starts with: ${LND_ADMIN_MACAROON.substring(0, 10)}...`,
    }
  }

  return { valid: true }
}

/**
 * Create a deposit invoice for a user
 */
export async function createDepositInvoice(amount: number, userId: string) {
  try {
    console.log("Creating deposit invoice for user:", userId, "Amount:", amount)

    // Create a Supabase client with the user's session
    const cookieStore = await getCookieStore()
    const supabase = createServerSupabaseClient({ cookieStore })

    // Get the current user
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession()

    if (sessionError) {
      console.error("Session error:", sessionError)
      return { success: false, error: "Authentication error", details: sessionError.message }
    }

    // Use the passed userId if no session is found
    // This allows the client to pass the user ID when the session might not be available
    const effectiveUserId = session?.user?.id || userId

    if (!effectiveUserId) {
      console.error("No user ID provided and no active session found")
      return { success: false, error: "Not authenticated" }
    }

    console.log("Creating invoice for user:", effectiveUserId)

    // Check Lightning configuration
    const configCheck = await checkLightningConfig()
    if (!configCheck.valid) {
      console.error("Lightning config check failed:", configCheck.error, configCheck.details)
      return {
        success: false,
        error: configCheck.error,
        details: configCheck.details,
      }
    }

    // Use service role key for admin access to bypass RLS
    const adminSupabase = createServerSupabaseClient({
      supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    })

    // Check if the transactions table exists
    const { error: tableCheckError } = await adminSupabase.from("transactions").select("id").limit(1)

    if (tableCheckError) {
      console.error("Transactions table check error:", tableCheckError)
      return { success: false, error: "Transactions table not found. Please run the database migrations." }
    }

    // Create a memo for the invoice
    const memo = `Deposit ${amount} sats to Ganamos!`

    // Create the invoice using the Lightning API
    const invoiceResult = await createInvoice(amount, memo)

    if (!invoiceResult.success) {
      return {
        success: false,
        error: "Failed to create invoice",
        details: invoiceResult.error || invoiceResult.details,
      }
    }

    // Convert binary r_hash to hex string if needed
    let rHashStr = invoiceResult.rHash
    if (typeof rHashStr === "object" && rHashStr !== null) {
      // If it's a Buffer or similar binary object, convert to hex string
      rHashStr = Buffer.from(rHashStr).toString("hex")
    }

    // Store the invoice in the database with explicit data types
    const { data, error } = await adminSupabase
      .from("transactions")
      .insert({
        user_id: effectiveUserId,
        type: "deposit",
        amount: amount,
        status: "pending",
        r_hash_str: rHashStr || null,
        payment_request: invoiceResult.paymentRequest || null,
        memo: memo || null,
      })
      .select()

    if (error) {
      console.error("Error storing invoice:", error)
      return { success: false, error: "Failed to store invoice: " + error.message }
    }

    console.log("Invoice created successfully:", rHashStr)

    return {
      success: true,
      paymentRequest: invoiceResult.paymentRequest,
      rHash: rHashStr,
    }
  } catch (error) {
    console.error("Unexpected error in createDepositInvoice:", error)
    return {
      success: false,
      error: "An unexpected error occurred",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check if a deposit invoice has been paid
 */
export async function checkDepositStatus(rHash: string, userId: string) {
  try {
    console.log("Checking deposit status for rHash:", rHash, "User ID:", userId)

    const cookieStore = await getCookieStore()
    const supabase = createServerSupabaseClient({ cookieStore })

    // Get the current user
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession()

    // Use the passed userId if no session is found
    const effectiveUserId = session?.user?.id || userId

    if (sessionError) {
      console.error("Session error:", sessionError)
      // Continue with the provided userId instead of returning an error
    }

    if (!effectiveUserId) {
      console.error("No user ID provided and no active session found")
      return { success: false, error: "Not authenticated" }
    }

    // Check the invoice status
    const invoiceStatus = await checkInvoice(rHash)

    if (!invoiceStatus.success) {
      return { success: false, error: "Failed to check invoice status" }
    }

    // If the invoice is settled, update the transaction and user balance
    if (invoiceStatus.settled && invoiceStatus.settled === true) {
      console.log("Invoice is settled! Processing payment for user:", effectiveUserId)

      // Use service role key for admin access to bypass RLS
      const adminSupabase = createServerSupabaseClient({
        supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      })

      // Get the transaction to verify amount
      const { data: transaction } = await adminSupabase
        .from("transactions")
        .select("*")
        .eq("r_hash_str", rHash)
        .eq("status", "pending")
        .single()

      if (!transaction) {
        console.log("Transaction not found or already processed")
        return { success: false, error: "Transaction not found or already processed" }
      }

      console.log("Found transaction:", transaction.id, "Amount:", transaction.amount)

      // Get the user's current balance
      const { data: profile } = await adminSupabase
        .from("profiles")
        .select("balance")
        .eq("id", effectiveUserId)
        .single()

      if (!profile) {
        console.error("User profile not found")
        return { success: false, error: "User profile not found" }
      }

      console.log("Current balance:", profile.balance)
      const newBalance = profile.balance + transaction.amount
      console.log("New balance will be:", newBalance)

      // Update transaction status
      const { error: txError } = await adminSupabase
        .from("transactions")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", transaction.id)

      if (txError) {
        console.error("Error updating transaction:", txError)
        return { success: false, error: "Failed to update transaction" }
      }

      console.log("Transaction updated successfully")

      // Update user balance
      const { error: balanceError } = await adminSupabase
        .from("profiles")
        .update({
          balance: newBalance,
          updated_at: new Date().toISOString(),
        })
        .eq("id", effectiveUserId)

      if (balanceError) {
        console.error("Error updating balance:", balanceError)
        return { success: false, error: "Failed to update balance" }
      }

      console.log("Balance updated successfully to:", newBalance)

      // Revalidate the profile page to show updated balance
      revalidatePath("/profile")
      revalidatePath("/dashboard")
      revalidatePath("/wallet")

      return {
        success: true,
        settled: true,
        amount: transaction.amount,
        newBalance,
      }
    }

    return {
      success: true,
      settled: false,
    }
  } catch (error) {
    console.error("Unexpected error in checkDepositStatus:", error)
    return {
      success: false,
      error: "An unexpected error occurred",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Process a withdrawal request
 */
export async function processWithdrawal(formData: FormData) {
  try {
    const cookieStore = await getCookieStore()
    const supabase = createServerSupabaseClient({ cookieStore })

    // Get the current user
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession()

    if (sessionError || !session) {
      console.error("Session error or no session:", sessionError)
      return { success: false, error: "Not authenticated" }
    }

    const userId = session.user.id

    // Get the payment request and amount from the form
    const paymentRequest = formData.get("paymentRequest") as string
    const amount = Number.parseInt(formData.get("amount") as string, 10)

    if (!paymentRequest || isNaN(amount) || amount <= 0) {
      return { success: false, error: "Invalid payment request or amount" }
    }

    // Use service role key for admin access to bypass RLS
    const adminSupabase = createServerSupabaseClient({
      supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    })

    // Check if the user has enough balance
    const { data: profile } = await adminSupabase.from("profiles").select("balance").eq("id", userId).single()

    if (!profile) {
      return { success: false, error: "User profile not found" }
    }

    if (profile.balance < amount) {
      return { success: false, error: "Insufficient balance" }
    }

    // Create a transaction record
    const { data: transaction, error: txError } = await adminSupabase
      .from("transactions")
      .insert({
        user_id: userId,
        type: "withdrawal",
        amount,
        status: "pending",
        payment_request: paymentRequest,
        memo: `Withdrawal of ${amount} sats from Ganamos!`,
      })
      .select()
      .single()

    if (txError || !transaction) {
      console.error("Error creating transaction:", txError)
      return { success: false, error: "Failed to create transaction" }
    }

    // Pay the invoice
    const paymentResult = await payInvoice(paymentRequest)

    if (!paymentResult.success) {
      // Update transaction to failed
      await adminSupabase
        .from("transactions")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", transaction.id)

      return { success: false, error: "Failed to pay invoice" }
    }

    // Update transaction with payment hash and status
    await adminSupabase
      .from("transactions")
      .update({
        status: "completed",
        payment_hash: paymentResult.paymentHash,
        updated_at: new Date().toISOString(),
      })
      .eq("id", transaction.id)

    // Update user balance
    const newBalance = profile.balance - amount
    await adminSupabase
      .from("profiles")
      .update({
        balance: newBalance,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)

    // Revalidate the profile page to show updated balance
    revalidatePath("/profile")
    revalidatePath("/dashboard")
    revalidatePath("/wallet")

    return {
      success: true,
      paymentHash: paymentResult.paymentHash,
      newBalance,
    }
  } catch (error) {
    console.error("Unexpected error in processWithdrawal:", error)
    return {
      success: false,
      error: "An unexpected error occurred",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}
