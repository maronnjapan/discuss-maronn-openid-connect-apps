/** @jsxImportSource hono/jsx */
import { Page, SERVICE_NAME } from './views.js';

/** The top page: what this IdP is and where its metadata lives. */
export function landingPage(issuer: string) {
  return (
    <Page title="トップ">
      <h1>{SERVICE_NAME}</h1>
      <p>
        <a href="https://github.com/maronnjapan/maronn-openid-connect">maronn-openid-connect</a> で構築した OpenID
        Provider です。ログインは連携しているアプリから行います。
      </p>
      <p class="muted">
        Issuer: <code>{issuer}</code>
        <br />
        Discovery: <a href="/.well-known/openid-configuration">/.well-known/openid-configuration</a>
      </p>
    </Page>
  );
}
