/**
 * The steps on claude.ai that scripts/deploy.mjs shows for the routine and
 * its cloud environment, and which of them have to be redone.
 *
 * The environment's network access, its network secrets and the routine's
 * API token can only be set in claude.ai's web UI (there is no API or CLI
 * for them), so they are not automated. deploy.mjs keeps fingerprints of the
 * values last shown and confirmed (routineSetup in .deploy/state.json) and
 * shows again only the steps whose values differ.
 *
 * Nothing here has side effects, so the guide can be printed for any state.
 */
import { createHash } from 'node:crypto';
import { routineAllowedDomains, routineNetworkSecret, routinePrompt } from '../apps/planner/src/routine/prompt.ts';

const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The values to enter on claude.ai, and their fingerprints. The network
 * secret's fingerprint covers the hash of its token (bearerTokenHash), so a
 * new token shows the step to add the secret again.
 */
export function routineSetupValues({ plannerOrigin, bearerTokenHash }) {
  const networkSecret = routineNetworkSecret({ appOrigin: plannerOrigin });
  const allowedDomains = routineAllowedDomains(plannerOrigin);
  const prompt = routinePrompt({ appOrigin: plannerOrigin });
  return {
    networkSecret,
    allowedDomains,
    prompt,
    fingerprints: {
      secret: fingerprint({ ...networkSecret, tokenHash: bearerTokenHash ?? null }),
      domains: fingerprint(allowedDomains),
      prompt: fingerprint(prompt),
    },
  };
}

/** What has to be redone since the setup last confirmed (previous: undefined when none was). */
export function routineSetupChanges({ previous, current }) {
  const last = previous ?? {};
  return {
    secret: last.secret !== current.secret,
    domains: last.domains !== current.domains,
    prompt: last.prompt !== current.prompt,
  };
}

export const hasChanges = (changes) => changes.secret || changes.domains || changes.prompt;

/**
 * Why the steps are shown again, for a deployment set up before.
 * migrating: the setup predates the network secret of type Bearer (the agent
 *   proxy then got an access token at the IdP with client credentials).
 * unrecorded: no setup was recorded as confirmed yet.
 * tokenChanged: another bearer token was entered for the planner.
 */
export function changeReasons({ changes, migrating, unrecorded, tokenChanged }) {
  const reasons = [];
  if (changes.secret) {
    if (migrating) {
      reasons.push(
        'network secret の種類を Bearer に変えました。planner は IdP のアクセストークンではなく、network secret に入れたトークンを確かめます（IdP の client credentials は削除しました）。',
      );
    } else if (tokenChanged) {
      reasons.push('planner に登録する Bearer トークンを変えました。network secret の Value も同じ値にしてください。');
    } else if (unrecorded) {
      reasons.push('network secret は、前回の設定の記録が無いため表示します（設定済みなら変更不要）。');
    } else {
      reasons.push('network secret の Allowed websites が変わりました（planner の URL が変わったため）。');
    }
  }
  if (changes.domains) {
    reasons.push(unrecorded ? '許可ドメインは、前回の設定の記録が無いため表示します（設定済みなら変更不要）。' : '許可ドメインが変わりました。');
  }
  if (changes.prompt) reasons.push('ルーチンに保存するプロンプトが変わりました。');
  return reasons;
}

const OPEN_ENVIRONMENT =
  'ルーチンの詳細ページ（https://claude.ai/code/routines）で、名前の横のメニュー → Edit → Advanced settings > General > Cloud environment の環境名 → 環境の行の設定アイコン';

/**
 * The guide as text.
 *
 * full: every step, for a routine being set up (with the API trigger);
 *   otherwise only the steps in changes.
 * wait: the user finishes the steps before the deployment goes on.
 * tokenValue: what to enter as the Value of the network secret's header.
 */
export function formatRoutineGuide({ values, changes, full, wait, reasons = [], tokenValue, promptFile }) {
  const { networkSecret, allowedDomains, prompt } = values;
  const show = full ? { domains: true, secret: true, prompt: true } : changes;
  const unchanged = (key) => (full && !changes[key] ? '（設定済みなら変更不要）' : '');
  const networkAccess = `      Network access   Custom
        Allowed domains（1 行に 1 つ）
${allowedDomains.map((domain) => `          ${domain}`).join('\n')}
        「Also include default list of common package managers」を有効にする`;

  const steps = [];
  if (full) {
    steps.push(`ルーチン専用の環境（Cloud environment）を用意する${unchanged('domains')}
    新しく作る：claude.ai/code の新規セッション画面で、メッセージ欄の下の環境セレクター → New environment
    既存の環境を直す：${OPEN_ENVIRONMENT}
      Name             maronn-planner-routine（任意）
${networkAccess}`);
  } else if (show.domains) {
    steps.push(`ルーチンの環境の Network access を次のとおりにする
    ${OPEN_ENVIRONMENT}
${networkAccess}`);
  }
  if (show.secret) {
    steps.push(`同じ環境の Network secrets に、planner へ送る Bearer トークンを追加する${unchanged('secret')}
    Edit cloud environment の Network secrets → Add secret。以前の secret（Name が「${networkSecret.name}」か「maronn IdP client credentials」）があれば先に削除する（保存した secret は編集できない）
      Secret type        ${networkSecret.secretType}
      Name               ${networkSecret.name}
      Allowed websites   ${networkSecret.allowedWebsite}   ← planner のホスト
      Custom headers     Name ${networkSecret.header.name}、Prefix ${networkSecret.header.prefix}、Value は次の値
                         ${tokenValue}
    エージェントのプロキシが planner へのリクエストに Authorization: Bearer <Value> を付けます。planner はこの値のハッシュだけを持ちます。`);
  }
  if (full) {
    steps.push(
      `ルーチン（https://claude.ai/code/routines）を開く（無ければ作る）${unchanged('prompt')}
      リポジトリ   maronnjapan/maronn-openid-connect
      モデル       Opus
      環境         [1] の環境（Advanced settings > General > Cloud environment）
      コネクタ     すべて外す（外部から来る依頼を扱うため、書き込みのできる道具を持たせない）
      プロンプト   下の文面（${promptFile} にも保存した）`,
      'トリガーに API を追加し、表示された URL とトークンを控える（トークンは一度しか表示されない）',
    );
  } else if (show.prompt) {
    steps.push(`ルーチンのプロンプトを下の文面に差し替える（${promptFile} にも保存した）
    ルーチンの詳細ページで、名前の横のメニュー → Edit。Claude Code の /schedule update でも差し替えられる`);
  }

  const instruction = wait
    ? `${full ? '次を設定してから、API トリガーの URL とトークン、network secret の Value を入力してください。' : '次を設定してください。'}終わるまで、Cloudflare には何も作成しません。`
    : '次を claude.ai で設定してください。';
  const lines = [
    '',
    '\x1b[1mルーチン（Claude Code のスケジュールタスク）と実行環境の設定\x1b[0m',
    '',
    'planner は依頼のたびにルーチンを API で起動し、ルーチンは結果を planner の受け口に送り返します。',
    `その送信に付ける Bearer トークンは、実行環境の network secret（Secret type: ${networkSecret.secretType}）が付けます。エージェントのプロキシが VM の外で付けるので、トークンはルーチンの Claude からは見えません。`,
    '実行環境のネットワーク設定と network secret、API トリガーのトークンは claude.ai の画面でしか設定できない（API と CLI が無い）ため、ここは手で設定します。',
    ...(reasons.length > 0 ? ['', ...reasons.map((reason) => `  ・${reason}`)] : []),
    '',
    instruction,
    '',
    steps.map((step, index) => `[${index + 1}] ${step}`).join('\n\n'),
    '',
  ];
  if (full || show.prompt) {
    lines.push(`\x1b[2m----- ルーチンに保存するプロンプト（ここから） -----\x1b[0m\n${prompt}\n\x1b[2m----- ここまで -----\x1b[0m`, '');
  }
  return lines.join('\n');
}
