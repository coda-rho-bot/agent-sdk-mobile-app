import { authorizationCodeFromResult } from "@angus/letta-client-core";
import {
  AuthRequest,
  CodeChallengeMethod,
  makeRedirectUri,
  ResponseType,
} from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";

import {
  exchangeAuthorizationCode,
  getOAuthClientId,
  LETTA_OAUTH_BASE_URL,
  type OAuthCredential,
} from "@angus/letta-client-core";

export { OAuthCancelledError } from "@angus/letta-client-core";

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: `${LETTA_OAUTH_BASE_URL}/oauth/authorize`,
};

export function getOAuthRedirectUri(): string {
  return makeRedirectUri({
    native: "letta-mobile://oauth/callback",
    scheme: "letta-mobile",
    path: "oauth/callback",
  });
}

export async function signInWithLetta(): Promise<OAuthCredential> {
  const clientId = getOAuthClientId();
  if (!clientId) {
    throw new Error("OAuth is not configured in this build. Use an API key for now.");
  }

  const redirectUri = getOAuthRedirectUri();
  const request = new AuthRequest({
    clientId,
    redirectUri,
    responseType: ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: CodeChallengeMethod.S256,
  });
  const result = await request.promptAsync(discovery);
  const code = authorizationCodeFromResult(result);
  if (!request.codeVerifier) {
    throw new Error("Letta Cloud did not return the required sign-in details.");
  }
  return exchangeAuthorizationCode({
    clientId,
    code,
    codeVerifier: request.codeVerifier,
    redirectUri,
  });
}
