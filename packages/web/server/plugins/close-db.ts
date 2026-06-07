/** End the read-only Postgres pool on Nitro shutdown so dev HMR / graceful stops don't leak connections. */
import { closeDb } from '../utils/db'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', async () => {
    await closeDb()
  })
})
