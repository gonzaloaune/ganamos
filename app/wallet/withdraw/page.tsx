"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { processWithdrawal } from "@/app/actions/lightning-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { LoadingSpinner } from "@/components/loading-spinner"
import { ArrowLeftIcon } from "lucide-react"
import { useAuth } from "@/components/auth-provider"

export default function WithdrawPage() {
  const router = useRouter()
  const { user, profile, loading: authLoading } = useAuth()
  const [amount, setAmount] = useState<number>(1000)
  const [paymentRequest, setPaymentRequest] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(false)
  const [balance, setBalance] = useState<number>(0)
  const [loadingBalance, setLoadingBalance] = useState<boolean>(true)
  const { toast } = useToast()

  // Check if user is authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      toast({
        title: "Authentication Required",
        description: "Please sign in to access this feature",
        variant: "destructive",
        duration: 2000,
      })
      router.push("/auth/login?redirect=/wallet/withdraw")
      return
    }

    // Fetch user balance
    if (profile) {
      setBalance(profile.balance)
      setLoadingBalance(false)
    }
  }, [user, authLoading, profile, router, toast])

  // Process withdrawal
  const handleWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!user) {
      toast({
        title: "Authentication Required",
        description: "Please sign in to withdraw funds",
        variant: "destructive",
        duration: 2000,
      })
      router.push("/auth/login?redirect=/wallet/withdraw")
      return
    }

    if (amount < 100) {
      toast({
        title: "Invalid amount",
        description: "Minimum withdrawal is 100 sats",
        variant: "destructive",
        duration: 2000,
      })
      return
    }

    if (!paymentRequest || !paymentRequest.startsWith("lnbc")) {
      toast({
        title: "Invalid invoice",
        description: "Please enter a valid Lightning invoice",
        variant: "destructive",
        duration: 2000,
      })
      return
    }

    if (amount > balance) {
      toast({
        title: "Insufficient balance",
        description: "You don't have enough funds for this withdrawal",
        variant: "destructive",
        duration: 2000,
      })
      return
    }

    setLoading(true)
    try {
      // Wait a moment to ensure authentication is fully established
      await new Promise((resolve) => setTimeout(resolve, 500))

      const formData = new FormData()
      formData.append("paymentRequest", paymentRequest)
      formData.append("amount", amount.toString())

      const result = await processWithdrawal(formData)

      if (result.success) {
        toast({
          title: "Withdrawal successful!",
          description: `${amount} sats have been sent to your wallet`,
          variant: "default",
          duration: 2000,
        })
        setPaymentRequest("")
        setBalance(result.newBalance)
      } else {
        // Handle authentication errors specifically
        if (result.error === "Not authenticated") {
          toast({
            title: "Session Expired",
            description: "Your session has expired. Please log in again.",
            variant: "destructive",
            duration: 2000,
          })
          router.push("/auth/login?redirect=/wallet/withdraw")
          return
        }

        toast({
          title: "Withdrawal failed",
          description: result.error || "Failed to process withdrawal",
          variant: "destructive",
          duration: 2000,
        })
      }
    } catch (error) {
      console.error("Error processing withdrawal:", error)
      toast({
        title: "Error",
        description: "An unexpected error occurred",
        variant: "destructive",
        duration: 2000,
      })
    } finally {
      setLoading(false)
    }
  }

  // Show loading state while checking authentication
  if (authLoading) {
    return (
      <div className="container max-w-md mx-auto py-8 px-4">
        <div className="flex items-center mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()} className="mr-2">
            <ArrowLeftIcon className="h-5 w-5" />
            <span className="sr-only">Back</span>
          </Button>
          <h1 className="text-2xl font-bold">Withdraw Bitcoin</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-12">
          <LoadingSpinner />
          <p className="mt-4 text-muted-foreground">Checking authentication...</p>
        </div>
      </div>
    )
  }

  // If not authenticated, show login prompt
  if (!user) {
    return (
      <div className="container max-w-md mx-auto py-8 px-4">
        <div className="flex items-center mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()} className="mr-2">
            <ArrowLeftIcon className="h-5 w-5" />
            <span className="sr-only">Back</span>
          </Button>
          <h1 className="text-2xl font-bold">Withdraw Bitcoin</h1>
        </div>

        <Card>
          <CardContent className="p-6">
            <div className="text-center py-8">
              <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
              <p className="text-muted-foreground mb-6">Please sign in to withdraw funds</p>
              <Button onClick={() => router.push("/auth/login?redirect=/wallet/withdraw")}>Sign In</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container max-w-md mx-auto py-8 px-4">
      <div className="flex items-center mb-6">
        <Button variant="ghost" size="icon" onClick={() => router.back()} className="mr-2">
          <ArrowLeftIcon className="h-5 w-5" />
          <span className="sr-only">Back</span>
        </Button>
        <h1 className="text-2xl font-bold">Withdraw Bitcoin</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Withdraw Bitcoin</CardTitle>
          <CardDescription>Send funds from your Ganamos! account to your Lightning wallet</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleWithdrawal} className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <label htmlFor="amount" className="text-sm font-medium">
                  Amount (sats)
                </label>
                <span className="text-sm text-gray-500">
                  Balance: {loadingBalance ? "Loading..." : `${balance} sats`}
                </span>
              </div>
              <Input
                id="amount"
                type="number"
                min="100"
                max={balance}
                value={amount}
                onChange={(e) => setAmount(Number.parseInt(e.target.value, 10))}
                placeholder="Enter amount in sats"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="invoice" className="text-sm font-medium">
                Lightning Invoice
              </label>
              <Input
                id="invoice"
                value={paymentRequest}
                onChange={(e) => setPaymentRequest(e.target.value)}
                placeholder="lnbc..."
              />
              <p className="text-xs text-gray-500">
                Generate an invoice in your Lightning wallet for the amount you want to withdraw
              </p>
            </div>

            <Button type="submit" className="w-full" disabled={loading || loadingBalance || balance < 100}>
              {loading ? <LoadingSpinner /> : "Withdraw"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex justify-center text-sm text-gray-500">
          <p>Withdrawals are typically processed within seconds</p>
        </CardFooter>
      </Card>
    </div>
  )
}
