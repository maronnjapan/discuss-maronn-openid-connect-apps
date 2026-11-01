import {
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-access-token',
  endpoint: 'token',
  kind: 'issue',
  label: 'Issue the access token',
  spec: 'RFC 9068 §2.2 / §2.2.1 / §3',
  function: 'issueAccessToken',
  calls: ['buildAccessTokenAudience', 'buildAccessTokenPayload', 'createJwtAccessTokenIssuer', 'createOpaqueAccessTokenIssuer'],
  consumes: ['signingKey', 'subject', 'validatedRequest', 'acr'],
  produces: ['issuedAt', 'accessToken', 'accessTokenPayload', 'audience'],
  removable: false,
});

/**
 * Issue the access token: decide its audience, build the RFC 9068 payload
 * and sign it (JWT) or mint an opaque reference, as config.accessTokenFormat says.
 * RFC 9068 §2.2 / §2.2.1 / §3
 */
export async function issueAccessToken(
  c: any,
  input: {
    signingKey: SigningKey;
    subject: string;
    validatedRequest: ValidatedTokenRequest;
    /** One timestamp for the whole response so the tokens and the stored records agree on iat / exp. */
    issuedAt: number;
    /** The acr of the authentication (the ID Token carries the same); undefined leaves the claim out. */
    acr: string | undefined;
  },
): Promise<{ accessToken: string; accessTokenPayload: { jti?: string }; audience: string[] }> {
  const { signingKey, subject, validatedRequest, issuedAt, acr } = input;
  const config = c.get('config');

  // Choose access token issuer based on config (default: JWT).
  // Opaque tokens are recommended when immediate revocation is required,
  // since the resource server can call the introspection endpoint instead
  // of self-validating a JWT.
  const accessTokenIssuer: AccessTokenIssuer =
    config.accessTokenFormat === 'opaque'
      ? createOpaqueAccessTokenIssuer()
      : createJwtAccessTokenIssuer();

  // アクセストークンの audience を決定する（合成ポリシーは core の buildAccessTokenAudience に集約）。
  // RFC 9068 §3: JWT access token の aud は非空でなければならない。
  // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使用できるため、UserInfo
  // エンドポイント（discovery が広告する userinfo_endpoint と同じ URL）を aud の恒久メンバとして
  // 必ず含める。resource 指定（validatedRequest.audience）があれば末尾に追加し、UserInfo
  // エンドポイントを取り除くことはしない。重複は除去される。
  // refresh では保存済み aud（既に UserInfo を含む）を引き継ぐため、再計算しても同一集合になる。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: validatedRequest.audience,
    issuer: config.issuer,
  });

  // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id, and the
  // acr of the authentication (§2.2.1) when there is one.
  // Add access token claims here before the payload is signed.
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
    acr,
  });

  // JWT or opaque, chosen above from config.accessTokenFormat.
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });

  return { accessToken, accessTokenPayload, audience };
}
