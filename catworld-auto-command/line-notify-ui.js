// 設定頁的「手機通知（LINE）」區塊：token 與 userId 只存在這台瀏覽器的本機儲存（storage.local），
// 不用跨裝置同步的 storage.sync、也不進任何匯出；欄位是密碼欄位。不得把它們印到 console 或顯示在結果裡。
// 發送交給 background（訊息裡不帶憑證，background 自己從儲存讀），這裡只負責欄位與結果顯示。
(() => {
if (globalThis.CatworldLineNotifyUI) return;

const KEY = 'lineNotify';
const RESULT_KEY = 'lineLastResult';
const THROTTLE_KEY = 'lineThrottle';
const DEFAULT_LIMIT = 10;
// 上限與核心模組一致（popup.html 先載入 line-notify.js）；沒載入時用同樣的數字，不讓設定頁壞掉
const MAX_DEDUPE_MINUTES = globalThis.CatworldLineNotify?.MAX_DEDUPE_MINUTES ?? 24 * 60;
const MAX_HOURLY_LIMIT = globalThis.CatworldLineNotify?.MAX_HOURLY_LIMIT ?? 100;
const pad = value => String(value).padStart(2, '0');

// 最近一次發送結果的顯示：時間、HTTP 狀態、簡短原因；status 0 表示根本沒發出去（沒填憑證或網路錯誤）
function formatResult(result) {
  const at = new Date(result.at);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  // 結果是測試按鈕還是警報推播寫的，要分得出來，免得剛按完測試卻看到警報的結果
  const time = result.source === 'alert' ? `${clock}（警報）` : result.source === 'test' ? `${clock}（測試）` : clock;
  if (result.ok) return `${time}　HTTP ${result.status}　成功`;
  const reason = result.reason ? `：${result.reason}` : '';
  return result.status ? `${time}　HTTP ${result.status}　失敗${reason}` : `${time}　沒有發出${reason}`;
}

function attach(doc) {
  const token = doc.getElementById('lineToken');
  const userId = doc.getElementById('lineUserId');
  const enabledBox = doc.getElementById('lineEnabled');
  const dedupe = doc.getElementById('lineDedupe');
  const hourly = doc.getElementById('lineHourly');
  const skippedBox = doc.getElementById('lineSkipped');
  const testButton = doc.getElementById('lineTest');
  const resultBox = doc.getElementById('lineResult');
  // 整數、至少 1、不超過上限；空白或不是正數就存成 null（背景程式會改用預設值 10 分鐘、每小時 10 則）
  const limit = (field, max) => {
    const number = Number(field.value);
    return field.value.trim() !== '' && Number.isFinite(number) && number > 0 ? Math.min(Math.max(1, Math.floor(number)), max) : null;
  };
  const credentials = () => ({
    token: token.value.trim(), userId: userId.value.trim(), enabled: enabledBox.checked,
    dedupeMinutes: limit(dedupe, MAX_DEDUPE_MINUTES), hourlyLimit: limit(hourly, MAX_HOURLY_LIMIT),
  });
  const lockable = [token, userId, enabledBox, dedupe, hourly];

  // 儲存的憑證載入完成之前欄位先停用：否則一打字就會把「還沒載入的空欄位」存回去，蓋掉已存的值；載入失敗也要放行
  let loaded = false;
  lockable.forEach(field => { field.disabled = true; });
  chrome.storage.local.get(KEY).then(data => {
    token.value = data[KEY]?.token ?? '';
    userId.value = data[KEY]?.userId ?? '';
    enabledBox.checked = data[KEY]?.enabled === true;
    dedupe.value = data[KEY]?.dedupeMinutes ?? DEFAULT_LIMIT;
    hourly.value = data[KEY]?.hourlyLimit ?? DEFAULT_LIMIT;
    loaded = true;
    lockable.forEach(field => { field.disabled = false; });
  }).catch(() => {
    // 讀不到已存的設定時欄位維持停用：這時打字會把「空的」存回去，蓋掉已存的憑證與開關
    say('讀取設定失敗，請重新整理設定頁再試', 'error');
  });

  // 驗證、錯誤、警告用 msg-error（紅）與 msg-warn（琥珀）標出來，一般訊息不上色（樣式在 popup.html）；換新訊息時舊的上色要一起清掉
  const say = (text, level = 'info') => {
    resultBox.textContent = text;
    resultBox.classList.toggle('msg-error', level === 'error');
    resultBox.classList.toggle('msg-warn', level === 'warn');
  };
  // 最近一次結果由 background 寫在 storage.session（關掉瀏覽器就沒了）；打開頁面時讀一次，之後跟著變更
  const show = result => { if (result) say(formatResult(result), result.ok ? 'info' : 'error'); };
  chrome.storage.session.get(RESULT_KEY).then(data => show(data[RESULT_KEY]));
  // 被去重或每小時上限略過的警報則數（由 background 累計在 storage.session）
  const showSkipped = state => {
    const skipped = state?.skipped ?? 0;
    skippedBox.textContent = `已略過 ${skipped} 則（同原因重複或超過每小時上限，只是沒推到手機）`;
    // 有被略過的警報是需要留意的（手機沒收到），沒有就不上色
    skippedBox.classList.toggle('msg-warn', skipped > 0);
  };
  chrome.storage.session.get(THROTTLE_KEY).then(data => showSkipped(data[THROTTLE_KEY])).catch(() => showSkipped(null));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[RESULT_KEY]) show(changes[RESULT_KEY].newValue);
    if (changes[THROTTLE_KEY]) showSkipped(changes[THROTTLE_KEY].newValue);
  });

  const save = async () => { if (loaded) await chrome.storage.local.set({ [KEY]: credentials() }); };
  // 開關開著時把任一個憑證清空：開關自動關掉並明講，否則警報會被靜默地丟掉，使用者還以為手機有被涵蓋
  const onCredentialInput = () => {
    const { token: t, userId: u } = credentials();
    if (loaded && enabledBox.checked && (!t || !u)) {
      enabledBox.checked = false;
      say('憑證已清空，手機通知已自動關閉', 'warn');
    }
    save();
  };
  token.addEventListener('input', onCredentialInput);
  userId.addEventListener('input', onCredentialInput);
  dedupe.addEventListener('input', save);
  hourly.addEventListener('input', save);
  // 離開欄位時把畫面改成「實際生效的值」，使用者才看得出填 0 或 2.5 或太大被換成了什麼
  dedupe.addEventListener('change', () => { dedupe.value = limit(dedupe, MAX_DEDUPE_MINUTES) ?? DEFAULT_LIMIT; });
  hourly.addEventListener('change', () => { hourly.value = limit(hourly, MAX_HOURLY_LIMIT) ?? DEFAULT_LIMIT; });

  // 總開關預設關閉；token 或 userId 沒填就開不起來（關掉不受限）
  enabledBox.addEventListener('change', () => {
    const { token: t, userId: u } = credentials();
    if (enabledBox.checked && (!t || !u)) {
      enabledBox.checked = false;
      say('請先填 token 與 userId，才能開啟手機通知', 'error');
      return;
    }
    save();
  });

  testButton.addEventListener('click', async () => {
    const { token: t, userId: u } = credentials();
    if (!t || !u) {
      say('請先填 token 與 userId', 'error');
      return;
    }
    // 發送中先停用按鈕：連點會連續花掉 LINE 的推播額度
    testButton.disabled = true;
    say('發送中…');
    try {
      await save();
      const result = await chrome.runtime.sendMessage({ type: 'LINE_TEST' });
      if (result) say(formatResult(result), result.ok ? 'info' : 'error');
      else say('沒有回應', 'error');
    } catch (error) {
      // background 沒啟動或沒回應（例如擴充功能剛重新載入）；訊息裡只有錯誤文字，不含憑證
      say(`沒有回應：${error?.message ?? error}`, 'error');
    } finally {
      testButton.disabled = false;
    }
  });
}

globalThis.CatworldLineNotifyUI = { attach, formatResult };
})();
