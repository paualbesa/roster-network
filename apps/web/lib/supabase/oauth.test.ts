import { describe, expect, it } from "vitest";
import {
  describeSignedInAccount,
  humanOAuthSignIn,
  oauthRedirectTo,
  readHumanAuthProvider,
  readStoredAuthProvider,
  safeConsoleNextPath,
} from "./oauth";

describe("human OAuth sign-in", () => {
  it("builds GitHub and Google redirects back to the console callback", () => {
    expect(humanOAuthSignIn("github", "https://roster.network/console")).toEqual({
      provider: "github",
      options: { redirectTo: "https://roster.network/auth/callback?next=%2Fconsole" },
    });
    expect(humanOAuthSignIn("google", "http://localhost:3000/")).toEqual({
      provider: "google",
      options: { redirectTo: "http://localhost:3000/auth/callback?next=%2Fconsole" },
    });
    expect(oauthRedirectTo(" http://127.0.0.1:7000 ")).toBe(
      "http://127.0.0.1:7000/auth/callback?next=%2Fconsole",
    );
  });

  it("refuses email and any non-http origin", () => {
    expect(() => humanOAuthSignIn("email", "https://roster.network")).toThrow(/GitHub or Google/);
    expect(() => humanOAuthSignIn("github", "javascript:alert(1)")).toThrow(/http/);
    expect(() => oauthRedirectTo("https://user:secret@roster.network")).toThrow(/credentials/);
    expect(() => oauthRedirectTo("not a url")).toThrow(/http/);
  });
});

describe("OAuth callback path", () => {
  it("keeps console paths and drops off-site targets", () => {
    expect(safeConsoleNextPath(null)).toBe("/console");
    expect(safeConsoleNextPath("/console/dashboard")).toBe("/console/dashboard");
    expect(safeConsoleNextPath("/admin")).toBe("/console");
    expect(safeConsoleNextPath("//evil.example/console")).toBe("/console");
    expect(safeConsoleNextPath("/console\\@evil.example")).toBe("/console");
    expect(safeConsoleNextPath("/console\n/etc")).toBe("/console");
  });
});

describe("signed-in account", () => {
  it("labels GitHub and Google from app metadata and ignores user-editable metadata", () => {
    expect(
      readHumanAuthProvider({
        app_metadata: { provider: "github" },
        identities: [{ provider: "email" }],
      }),
    ).toBe("github");
    expect(readHumanAuthProvider({ identities: [{ provider: "google" }] })).toBe("google");
    expect(readHumanAuthProvider({ app_metadata: { provider: "evil" } })).toBeNull();
    expect(readStoredAuthProvider("email")).toBe("email");
    expect(readStoredAuthProvider("password")).toBeUndefined();
  });

  it("describes the account shown on /console", () => {
    expect(describeSignedInAccount({ email: " ada@example.com ", provider: "github" })).toEqual({
      email: "ada@example.com",
      provider: "github",
      providerLabel: "GitHub",
      headline: "Signed in as ada@example.com with GitHub",
    });
    expect(describeSignedInAccount({ email: "", provider: "google" }).headline).toBe(
      "Signed in as this browser with Google",
    );
    expect(describeSignedInAccount({ email: "ada@example.com", provider: "email" }).headline).toBe(
      "Signed in as ada@example.com",
    );
    expect(describeSignedInAccount({ email: "ada@example.com" }).providerLabel).toBeNull();
  });
});
