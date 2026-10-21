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
  const testButton = doc.getElementById('lineTest');
  const resultBox = doc.getElementById('lineResult');
  const credentials = () => ({ token: token.value.trim(), userId: userId.value.trim(), enabled: enabledBox.checked });

  // 儲存的憑證載入完成之前欄位先停用：否則一打字就會把「還沒載入的空欄位」存回去，蓋掉已存的值；載入失敗也要放行
  let loaded = false;
  [token, userId, enabledBox].forEach(field => { field.disabled = true; });
  chrome.storage.local.get(KEY).then(data => {
    token.value = data[KEY]?.token ?? '';
    userId.value = data[KEY]?.userId ?? '';
    enabledBox.checked = data[KEY]?.enabled === true;
  }).catch(() => {}).finally(() => {
    loaded = true;
    [token, userId, enabledBox].forEach(field => { field.disabled = false; });
  });

  // 最近一次結果由 background 寫在 storage.session（關掉瀏覽器就沒了）；打開頁面時讀一次，之後跟著變更
  const show = result => { if (result) resultBox.textContent = formatResult(result); };
  chrome.storage.session.get(RESULT_KEY).then(data => show(data[RESULT_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[RESULT_KEY]) show(changes[RESULT_KEY].newValue);
  });

  const save = async () => { if (loaded) await chrome.storage.local.set({ [KEY]: credentials() }); };
  token.addEventListener('input', save);
  userId.addEventListener('input', save);

  // 總開關預設關閉；token 或 userId 沒填就開不起來（關掉不受限）
  enabledBox.addEventListener('change', () => {
    const { token: t, userId: u } = credentials();
    if (enabledBox.checked && (!t || !u)) {
      enabledBox.checked = false;
      resultBox.textContent = '請先填 token 與 userId，才能開啟手機通知';
      return;
    }
    save();
  });

  testButton.addEventListener('click', async () => {
    const { token: t, userId: u } = credentials();
    if (!t || !u) {
      resultBox.textContent = '請先填 token 與 userId';
      return;
    }
    // 發送中先停用按鈕：連點會連續花掉 LINE 的推播額度
    testButton.disabled = true;
    resultBox.textContent = '發送中…';
    try {
      await save();
      const result = await chrome.runtime.sendMessage({ type: 'LINE_TEST' });
      resultBox.textContent = result ? formatResult(result) : '沒有回應';
    } catch (error) {
      // background 沒啟動或沒回應（例如擴充功能剛重新載入）；訊息裡只有錯誤文字，不含憑證
      resultBox.textContent = `沒有回應：${error?.message ?? error}`;
    } finally {
      testButton.disabled = false;
    }
  });
}

globalThis.CatworldLineNotifyUI = { attach, formatResult };
})();
