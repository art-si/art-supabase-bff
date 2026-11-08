import { createServer } from 'node:http'
import serverless from 'serverless-http'
import { handleApi, handleAuthEntry } from '../../server/app'

// Adapt Node requests without opening a listener or starting in-process timers.
export const handler = serverless(
  createServer((req, res) => {
    if (handleAuthEntry(req, res)) return
    void handleApi(req, res)
  }),
  {
    basePath: '/.netlify/functions/bff',
    // Netlify decodes these bytes before delivery, preserving every supported download MIME.
    binary: true
  }
)
