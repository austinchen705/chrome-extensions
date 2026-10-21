// 設定頁的「手機通知（LINE）」區塊：token 與 userId 只存在這台瀏覽器的本機儲存（storage.local），
// 不用跨裝置同步的 storage.sync、也不進任何匯出；欄位是密碼欄位。不得把它們印到 console 或顯示在結果裡。
// 發送交給 background（訊息裡不帶憑證，background 自己從儲存讀），這裡只負責欄位與結果顯示。
(() => {
if (globalThis.CatworldLineNotifyUI) return;

const KEY = 'lineNotify';
const RESULT_KEY = 'lineLastResult';
const pad = value => String(value).padStart(2, '0');

// 最近一次發送結果的顯示：時間、HTTP 狀態、簡短原因；status 0 表示根本沒發出去（沒填憑證或網路錯誤）
function formatResult(result) {
  const at = new Date(result.at);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  if (result.ok) return `${time}　HTTP ${result.status}　成功`;
  const reason = result.reason ? `：${result.reason}` : '';
  return result.status ? `${time}　HTTP ${result.status}　失敗${reason}` : `${time}　沒有發出${reason}`;
}

function attach(doc) {
  const token = doc.getElementById('lineToken');
  const userId = doc.getElementById('lineUserId');
  const testButton = doc.getElementById('lineTest');
  const resultBox = doc.getElementById('lineResult');
  const credentials = () => ({ token: token.value.trim(), userId: userId.value.trim() });

  chrome.storage.local.get(KEY).then(data => {
    token.value = data[KEY]?.token ?? '';
    userId.value = data[KEY]?.userId ?? '';
  });

  // 最近一次結果由 background 寫在 storage.session（關掉瀏覽器就沒了）；打開頁面時讀一次，之後跟著變更
  const show = result => { if (result) resultBox.textContent = formatResult(result); };
  chrome.storage.session.get(RESULT_KEY).then(data => show(data[RESULT_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[RESULT_KEY]) show(changes[RESULT_KEY].newValue);
  });

  const save = () => chrome.storage.local.set({ [KEY]: credentials() });
  token.addEventListener('input', save);
  userId.addEventListener('input', save);

  testButton.addEventListener('click', async () => {
    const { token: t, userId: u } = credentials();
    if (!t || !u) {
      resultBox.textContent = '請先填 token 與 userId';
      return;
    }
    resultBox.textContent = '發送中…';
    await save();
    const result = await chrome.runtime.sendMessage({ type: 'LINE_TEST' });
    resultBox.textContent = result ? formatResult(result) : '沒有回應';
  });
}

globalThis.CatworldLineNotifyUI = { attach, formatResult };
})();
