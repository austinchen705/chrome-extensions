// 無名物品鑑定提示：不碰 DOM，content script、background、popup、測試共用。
//
// 雜物拿給衰老頭鑑定後，遊戲先印「你拿著…給衰老頭看了一下...」，再印「衰老頭給你<量詞><名稱>。」。
// 只有先看到前一句（60 秒內）才把後一句當成鑑定結果，避免把衰老頭的其他句子當成物品。
//
// 比對鍵去掉括號與空白（資料表的名稱帶洞數「劍鑄模 (二洞)」，遊戲輸出不一定有），去掉後同鍵有多筆就全列出、不猜。
// 建議：和使用者主要武器類型相關的物品一律「適合你，建議留著」；否則 LV3 以上留著、LV1～2 賣掉。
(() => {
if (globalThis.CatworldZapItems) return;

const WEAPON_TYPES = ['劍', '刀', '杖', '鞭', '拳套', '暗器'];
const HAND_WINDOW_MS = 60000;

const itemKey = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s/g, '');

function findIdentified(text, now, state) {
  if (/你拿著[^\n]{0,40}給衰老頭看了一下/.test(text)) state.handedAt = now;
  if (state.handedAt === null || now - state.handedAt > HAND_WINDOW_MS) return [];
  return Array.from(String(text).matchAll(/衰老頭給你([^。\n]+)。/g), match => match[1]);
}

// 句子裡被包含的最長名稱；同鍵的所有項目一起回傳
function matchItems(items, sentence) {
  const key = itemKey(sentence);
  const hits = items.map(item => ({ item, itemKey: itemKey(item.name) })).filter(hit => hit.itemKey && key.includes(hit.itemKey));
  const longest = Math.max(0, ...hits.map(hit => hit.itemKey.length));
  return hits.filter(hit => hit.itemKey.length === longest).map(hit => hit.item);
}

function advise(item, mainWeapon) {
  if (item.weapon && WEAPON_TYPES.includes(mainWeapon) && item.weapon === mainWeapon) return { action: 'fit', text: '適合你，建議留著' };
  return item.level >= 3 ? { action: 'keep', text: '建議留著' } : { action: 'sell', text: '建議賣掉' };
}

function describeIdentified(items, sentences, mainWeapon) {
  return sentences.map(sentence => ({
    sentence,
    candidates: matchItems(items, sentence).map(item => ({ item, advice: advise(item, mainWeapon) })),
  }));
}

// background 用：回 null 表示不是這個模組的訊息
function handleMessage(items, message) {
  if (message?.type !== 'ZAP_ITEM') return null;
  return { ok: true, results: describeIdentified(items, message.sentences || [], message.mainWeapon) };
}

globalThis.CatworldZapItems = {
  WEAPON_TYPES, HAND_WINDOW_MS, itemKey, findIdentified, matchItems, advise, describeIdentified, handleMessage,
};
})();
