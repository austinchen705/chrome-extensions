// 劇本對話的內建備援劇本（只在 background 載入，content script 不載）：共用試算表沒填或抓不到時用。
// 台詞裡的 {對方} 送出時換成對方的角色名；每一句都要能通過 chat-script.js 的 usableScripts（沒有分號、@等待、換行）。
globalThis.CatworldChatScriptData = {
  scripts: [
    {
      id: 'builtin-1',
      lines: [
        { who: 'A', text: '欸{對方} 你今天有上線喔' },
        { who: 'B', text: '有啊 剛下班' },
        { who: 'A', text: '這週天氣也太熱了吧' },
        { who: 'B', text: '對啊 我都不想出門' },
        { who: 'A', text: '那等等一起練功嗎' },
        { who: 'B', text: '好啊 十分鐘後' },
      ],
    },
  ],
};
