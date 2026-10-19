// 鑑定出來的裝備（以及 view 身上裝備）的「此物名曰」區塊：不碰 DOM，content script 與測試共用。
//
// 區塊長這樣（標籤中間有空白；品階、屬性、潛能不一定有；屬性可多行、數值可為負）：
//   此物名曰 ：鋼盔甲，盔甲類防具
//   防 禦 力 ：37 / 37            （武器是「傷 害 力 ：48 / 48」）
//   屬    性 ：+2   行動
//   佩帶條件 ：[使用者 xxx，]經驗 60000
// 區塊之間會夾雜文字圖案、「特殊物品非無名裝備…」、「共鑑定…」這類行：不認得的行一律略過，
// 不能被當成屬性，也不能讓區塊切壞。
(() => {
if (globalThis.CatworldZapEquipment) return;

const HEADER = /此物名曰\s*[：:]\s*(.+?)\s*[，,]\s*(\S+類(?:武器|防具))/;
const WEAPON_PRIMARY = /傷\s*害\s*力\s*[：:]\s*(\d+)\s*\/\s*\d+/;
const ARMOR_PRIMARY = /防\s*禦\s*力\s*[：:]\s*(\d+)\s*\/\s*\d+/;
const ATTRIBUTE = /^\s*屬\s*性\s*[：:]\s*([+-]?\d+)\s+(\S+)\s*$/;
const NEED_EXP = /佩帶條件\s*[：:](?:\s*使用者\s*[^，,]+[，,])?\s*經驗\s*(\d+)/;

// 遊戲各處對同一個屬性的寫法不一致（補助／輔助、回復／恢復）
const normalizeAttrName = name => String(name ?? '').trim().replace(/補助/g, '輔助').replace(/回復/g, '恢復');

function parseEquipmentBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      current = {
        name: header[1].trim(),
        category: header[2],
        kind: header[2].endsWith('武器') ? 'weapon' : 'armor',
        primary: null,
        attrs: [],
        needExp: null,
        raw: line,
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    current.raw += `\n${line}`;
    const primary = (current.kind === 'weapon' ? WEAPON_PRIMARY : ARMOR_PRIMARY).exec(line);
    if (primary) current.primary = Number(primary[1]);
    const attribute = ATTRIBUTE.exec(line);
    if (attribute) current.attrs.push({ name: normalizeAttrName(attribute[2]), value: Number(attribute[1]) });
    const need = NEED_EXP.exec(line);
    if (need) current.needExp = Number(need[1]);
  }
  return blocks;
}

globalThis.CatworldZapEquipment = { normalizeAttrName, parseEquipmentBlocks };
})();
