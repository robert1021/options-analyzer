import os from 'node:os'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// fix: sandbox (bwrap --unshare-net + seccomp) blocks uv_interface_addresses
// which makes Vite crash when host is 0.0.0.0. Patch networkInterfaces to
// fallback to loopback instead of throwing ERR_SYSTEM_ERROR.
try {
  os.networkInterfaces()
} catch {
  const fallback: ReturnType<typeof os.networkInterfaces> = {
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      } as any,
    ],
  }
  os.networkInterfaces = () => fallback
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      }
    }
  }
})
