import { createClient } from "@supabase/supabase-js"
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs"
import type { Database } from "@/lib/database.types"

interface SupabaseOptions {
  supabaseUrl?: string
  supabaseKey?: string
  cookieStore?: any // Using any to avoid direct import of next/headers
}

// Check for environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (typeof window !== "undefined" && (!supabaseUrl || !supabaseAnonKey)) {
  console.error("Missing Supabase environment variables:", {
    hasUrl: !!supabaseUrl,
    hasAnonKey: !!supabaseAnonKey,
  })
}

// For backward compatibility - returns the browser client
export const getSupabaseClient = () => {
  return createBrowserSupabaseClient()
}

// For client components - uses the auth helpers
export const createBrowserSupabaseClient = () => {
  return createClientComponentClient<Database>()
}

// For server components and API routes
export const createServerSupabaseClient = (options?: SupabaseOptions) => {
  const url = options?.supabaseUrl || (process.env.NEXT_PUBLIC_SUPABASE_URL as string)

  // Only access sensitive environment variables on the server side
  let key: string
  if (typeof window === "undefined") {
    // Server-side: can access sensitive environment variables
    key =
      options?.supabaseKey ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string)
  } else {
    // Client-side: only use public environment variables
    key = options?.supabaseKey || (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string)
  }

  // Create client with basic options first
  const clientOptions: any = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }

  // Only add cookies if cookieStore is provided and we're on server
  if (options?.cookieStore && typeof window === "undefined") {
    clientOptions.auth.cookies = {
      get(name: string) {
        return options.cookieStore.get(name)?.value
      },
    }
  }

  return createClient<Database>(url, key, clientOptions)
}
