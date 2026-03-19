import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  describe("CodexAuthPlugin", () => {
    test("surfaces refresh error details from OAuth responses", async () => {
      const fetchMock = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "refresh token revoked",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          )
        }

        throw new Error(`Unexpected fetch: ${url}`)
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const setAuth = mock(async () => {})
      const hooks = await CodexAuthPlugin({
        client: {
          auth: {
            set: setAuth,
          },
        },
      } as never)

      const provider = {
        models: {
          "gpt-5.4": {
            cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
          },
        },
      } as never

      const auth = hooks.auth
      expect(auth).toBeDefined()
      if (!auth) {
        throw new Error("Expected auth hooks to be defined")
      }

      const loadAuth = auth.loader
      expect(loadAuth).toBeDefined()
      if (!loadAuth) {
        throw new Error("Expected auth hooks to provide loader")
      }

      const loaded = await loadAuth(
        async () => ({
          type: "oauth" as const,
          access: "",
          refresh: "refresh-token",
          expires: Date.now() - 1_000,
          accountId: "acct_123",
        }),
        provider,
      )

      const fetchWithRefresh = loaded.fetch
      expect(fetchWithRefresh).toBeDefined()
      if (!fetchWithRefresh) {
        throw new Error("Expected auth loader to provide fetch")
      }

      await expect(
        fetchWithRefresh("https://api.openai.com/v1/responses", {
          headers: { authorization: "Bearer dummy" },
        }),
      ).rejects.toThrow("Token refresh failed: 400 invalid_grant refresh token revoked")
      expect(setAuth).not.toHaveBeenCalled()
    })
  })
})
