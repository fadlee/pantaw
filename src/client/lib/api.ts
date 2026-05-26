import { hc } from "hono/client"
import type { AppType } from "../../server/index"

/**
 * Hono RPC client. Type-safe end-to-end karena import `AppType`
 * langsung dari server. Di runtime, Hono cuma butuh shape route
 * (path strings), bukan handler logic, jadi tidak ada kode server
 * yang ikut bundle ke client.
 *
 * Karena server dan client sama-sama di-deploy sebagai 1 Worker,
 * base URL adalah relative ("/").
 */
export const api = hc<AppType>("/")
