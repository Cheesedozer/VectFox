# 🐰 VectHarePlus — SillyTavern 進階 RAG 系統

> *為你的角色扮演對話帶來完美記憶。* VectHarePlus 為 SillyTavern 帶來 LLM 萃取的聊天事件、原生稀疏向量混合搜尋與智慧記憶衰減。

![License](https://img.shields.io/badge/license-GPLv3-blue) ![Status](https://img.shields.io/badge/status-Active-brightgreen)

**Languages:** [English](README.md) | **繁體中文** | [日本語](README_JP.md) | [한국어](README_KR.md)

---

## 🎯 什麼是 VectHarePlus？

VectHarePlus 從原始的 VectHare 專案分支而來，是一套為 SillyTavern 打造的**進階檢索增強生成（RAG）系統**，新增了針對英文、日文、韓文、繁體中文與簡體中文的最佳化支援。

我之所以分支原本的 VectHare，是為了處理我個人 [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) 專案中的超大規模需求，這些專案的特性是：
- **極端規模:每篇故事 2,000+ 則回覆，每則回覆 1,000+ 字。摘要檢索回應時間不到 3 秒**
- 支援非英文語言（日文、韓文、繁體/簡體中文）。預設支援英文。
- 自動去除 [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) 的所有功能性標籤。
- 真正可用的超長期記憶（2000+ 則訊息）

一般的 SillyTavern 記憶擴充元件在這種負載下會完全崩潰，特別是當故事中含有大量 [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) 使用的功能性標籤時——這些標籤對記憶查詢毫無用處。因此，我需要一套能夠在大規模下清除這些標籤、同時維持高速向量化的工具。

大多數記憶擴充元件是為 100 則訊息以內的對話設計的，在那個規模下運作得很好。但當對話量超過這個門檻後，它們就被迫越來越激進地壓縮舊訊息。最後你會得到近期歷史的完整細節，加上舊內容的一團模糊壓縮——而且根本沒有辦法解決，因為你就是塞不進 100+ 則訊息的原始上下文到提示詞或自動建立的世界書條目裡。舊記憶**必須**被壓縮，這就代表細節會流失。

方輪汽車不管你怎麼調校都無法解決問題。我需要正確的工具來完成這項工作。我真正需要的是一個專用的向量資料庫後端，妥善地儲存所有這些記憶。

為此，VectHarePlus 使用專用的向量資料庫來儲存聊天中**每一個有意義的事件**。不管是第一則訊息還是第 2,000 則訊息，每個有意義的事件都會留在資料庫裡，隨時供 SillyTavern 搜尋。我想要的是一套生產等級的 SillyTavern 記憶向量系統，能夠擴展到 10k+ 則訊息，並在數秒內完成往返搜尋。

### 它解決了什麼問題

- 😩 在記憶儲存前去除 [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) 使用的所有功能性標籤。
- 🧠 在 [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) 的角色記憶之上加入故事為基礎的記憶。
- 💸 漫長對話讓你的 token 預算被無關歷史塞爆
- ✍️ 你必須手動編輯上下文來提醒角色關鍵事件

**VectHarePlus 解決方案：** 使用 **Qdrant** 作為專用向量資料庫，儲存聊天中每個有意義的事件，無論聊天有多長。對於還沒準備好執行額外服務的使用者，**僅使用 A1 與 A2 路徑的「輕量版」** 可以在 SillyTavern 內建的向量儲存上執行，不需要額外軟體——它與完整向量資料庫共享許多功能，只是規模較小。當你準備好建立真正的長期記憶系統時，升級到使用 Qdrant 的 **A3 路徑**。

注意：Qdrant 是免費且開源的

---

## 🧠 運作方式

向量搜尋就像一個非常聰明的「尋找」功能。它不是匹配確切的字詞，而是匹配**意義**——輸入「我餓了」也能找到「我們去吃午餐吧」這樣的訊息，因為*意思*相近。

VectHarePlus 是由兩個互相搭配的核心想法構建而成：

### 1. EventBase — 從時間窗萃取事件，而非每則回覆做摘要

大多數記憶擴充元件會把每一則（或幾則）AI 回覆摘要成一坨文字。乍聽之下很合理，直到你看清楚回覆裡實際的內容：

- 一段 100 句的回覆可能包含**5 個有意義的事件**（一場戰鬥、一個發現、一個約定、一次物品交換、一個關係轉折），埋在 95 句的對白填充、場景描寫與閒聊之中
- 另一則回覆可能**零個事件**——只是純粹的閒聊
- 第三則可能用 1000 字塞進**1 個事件**。

每則回覆做摘要的方式會把這三種情況壓平成「每則回覆一坨」——失去事件邊界、把重要轉折與填充混在一起，無論真的發生了什麼都產出相同形狀的資料。

**EventBase 會檢視一段近期訊息的時間窗，根據實際發生的內容萃取出 0、1 或多個結構化事件。** 每個事件是一筆獨立紀錄，附帶豐富的後設資料（`characters`、`locations`、`items`、`concepts`、`importance`、`DateTime` 等）——不只是一串描述文字。

如果 Tav 與 Astarion 在 3 位其他隊員與背景故事雜音之間有一段長達 100 句的購物之旅對話，EventBase 可能會從這堆文字中萃取出一個事件：

```
{
  description: "Tav and Astarion shopped for armor in Baldur's Gate.
                Astarion mocked the prices. Tav bought a leather chestpiece for 80gp.",
  importance: 0.6,
  source_window: [msg 142 → 154]
}
```

之後當你提到「還記得那次購物之旅嗎？」時，VectHarePlus 會檢索**這個事件**——不是 100 句原文，也不是把購物之旅與周邊無關閒聊平均成一團的模糊摘要。

### 2. 為什麼專用向量資料庫是天然的選擇

如果你只做每則回覆做摘要，其實**不需要**向量資料庫。你產出的是大致每則回覆一坨、形狀始終一致的資料，並隨著聊天成長遞迴地重新摘要。用一個簡單的文字檔就夠了——這也正是為什麼許多舊版記憶擴充元件從未費心使用真正的資料庫。

但一旦你採用 EventBase，情況就完全不同：

- 2,000 則回覆 → 可能會產生 **1,000–3,000 個結構化事件**（有些回覆萃取出好幾個，有些則零個）
- 每個事件都有豐富的欄位：characters、locations、items、concepts、keywords、importance、timestamps
- 你必須在使用者對話進行中，即時透過**意義 + 關鍵字 + 後設資料過濾**找出最相關的 5–10 個事件

這正是**像 Qdrant 這樣的專用向量資料庫所設計的工作負載**：許多帶有結構欄位的小型紀錄，同時支援密集向量相似度與稀疏關鍵字搜尋，加上後設資料過濾，再加上跨完整語料的全域 BM25 權重。用一個扁平的摘要檔案來做這件事意味著線性掃描、沒有關鍵字索引、沒有後設資料過濾，也無法擴展到幾百筆條目以上。

EventBase 並沒有*強迫*你使用 Qdrant——A1/A2 輕量路徑可以在 SillyTavern 內建的 Vectra 上執行。但一旦你的聊天事件超過數百個，Qdrant 才是真正為這種資料形狀打造的儲存層。

### 🧠 為什麼這比傳統記憶擴充元件好

大多數現有的記憶擴充元件採用兩種方法之一。兩種方法都會在聊天成長時失去細節。原因如下——以及 EventBase 如何避免這個問題：

| 面向 | 📝 滾動摘要 <br>*（多數「記憶」擴充元件）* | ✂️ 原始切塊 <br>*（舊版向量 RAG）* | 🧬 EventBase <br>*（VectHarePlus）* |
|---|---|---|---|
| **儲存什麼** | 一段不斷成長的摘要文字 | 每則訊息切成原始片段 | 帶後設資料的結構化事件紀錄 |
| **第 100 則訊息時** | 大致完整 | 完整 | 完整 |
| **第 200 則訊息時** | 嚴重壓縮——名字、數字、單次細節漂移或消失 | Token 預算溢位——舊片段依分數修剪或丟棄 | **完整**——舊事件仍在 DB 中，依相關性浮現 |
| **第 1,000+ 則訊息時** | 實際上已是一團模糊 | DB 膨脹；檢索變得吵雜，因為原始片段訊號低 | **完整**——僅拉出與目前場景相關的少數事件 |
| **「壓縮」做了什麼** | 把摘要再摘要，每次都失去資訊 | 沒有壓縮——但也沒有合成；原始文字檢索看運氣 | 一次性、語意性——萃取*有意義的事件*並丟棄填充。事件本身的細節得以保留。 |
| **檢索訊號** | 無——整段摘要永遠注入 | 對原始文字做向量相似度（捕捉同義改寫但也吵雜） | 對豐富欄位（`characters`、`items`、`locations`、`concepts`、`keywords` 加上密集意義）做向量 + BM25 混合 |
| **細節的去處** | 壓縮後永遠流失 | 片段分數低於門檻就流失 | **哪裡都不會去**——事件存活在向量資料庫，相關時就浮現 |
| **注入什麼** | 整段運作中的摘要（每一輪、每一次） | 幾則語意相近的原始訊息 | 僅與當下訊息相關的事件 |

**核心洞見：** 滾動摘要失去細節是因為它*丟棄*舊內容來騰出空間。原始切塊失去細節是因為*檢索在規模下崩壞*。EventBase 永遠保留每個有意義的事件——讓向量 + 關鍵字搜尋決定當下哪 5–10 個值得展示給 AI。細節沒有被壓縮；**無關內容被過濾掉了**。

> 💡 **你訊息的措辭對檢索結果影響很大。** 因為檢索是由你回覆的文字驅動的，所以你用的詞語很重要。例如，*「Mayla，妳記得我為什麼付贖金嗎？」* 和 *「Mayla，妳記得我為什麼付了 2000 元嗎？」* 會回傳非常不同的事件——「贖金」會拉進所有與該故事線相關的事件（綁架、談判、交付），而「2000 元」主要只匹配字面上提到 2000 這個數字的事件。如果你想讓 AI 回想起特定場景，請用該場景中**具故事意義的字詞**來錨定你的訊息，而不是像確切數字這類附帶細節。話雖如此，我做過測試，A3 路徑在 DB 中 1500+ 個事件的情況下，兩種輸入都能找到贖金事件，而 A1 與 A2 路徑（請參閱下方路徑說明）在第二種輸入時失敗了。第一種使用正確錨定詞語的輸入，在 A3 路徑下確實能得到更高品質的檢索結果。

---

## 🔍 混合搜尋：A1、A2 與 A3 路徑

VectHarePlus 結合**兩種訊號**來找出最佳結果：

- **訊號 1 - 向量相似度** — 基於意義（「餓」匹配「去吃午餐」）
- **訊號 2 - BM25 關鍵字分數** — 精確字詞匹配（「Astarion」匹配「Astarion」）

依照後端與設定，有**三條路徑**可以結合這兩種訊號：（從你的瀏覽器到 docker 上的專用向量資料庫）

### A1 — 標準後端 + BM25
瀏覽器執行向量搜尋取得前 ~100 個候選，然後僅針對這些候選計算 BM25 關鍵字分數。簡單的加權總和：`α × vectorScore + β × bm25Score`。

**取捨：** 速度快、適合較慢的電腦，但如果完美的關鍵字匹配落在前 100 個向量結果之外，就完全看不到。

### A2 — 標準後端 + Hybrid（推薦給不走 A3 路徑的多數使用者）
與 A1 相同，但加上：
- **RRF（Reciprocal Rank Fusion，倒數排名融合）** — 依*位置*而非原始分數結合結果
- **雙訊號加成** — 同時出現在兩個列表的結果獲得最多 +8% 加成

**範例：** 搜尋「Astarion drinks blood.」一個同時被向量（「吸血鬼/飢餓」）*以及* BM25（字面「Astarion」+「blood」）匹配到的事件，會比只出現在其中一個列表的事件排名更高。

**取捨：** 在速度較快的電腦瀏覽器上有更好的融合，但仍受限於向量 top-K 100 個候選池。（仍然只是前 100 個樣本）

### A3 — Qdrant 原生稀疏 + 伺服器端 RRF（最佳準確度）
兩種搜尋在**單一 API 呼叫中於 Qdrant 向量資料庫內部執行**。每個儲存點都有兩種向量：密集向量（意義）與稀疏向量（關鍵字頻率）。Qdrant 跨**完整語料**計算 BM25 權重（真實的 IDF，不會偏差），然後用原生 RRF 進行融合。關鍵字端不受密集搜尋頂部結果的限制——如果某個事件包含你的查詢字詞，就符合資格，即使它的意義向量並不接近。而 BM25 字詞重要性權重是用資料庫中**每一個事件**的統計數據計算的（不只是前 100 個樣本），所以稀有字詞會得到正確的評分。

**範例：** 搜尋「I cast Fireball at the dragon.」Qdrant 同時搜尋它的密集索引（找咒語/攻擊意義）與稀疏索引（找字面「Fireball」與「dragon」），在伺服器端融合，回傳一份排名列表。

**取捨：** 準確度最佳，規模下最快。但你需要額外執行一個跑著 Qdrant 向量資料庫的 docker。

| 後端設定 | 你得到的路徑 |
|---|---|
| Standard（Vectra - SillyTavern 標準向量格式）+ BM25 | A1 |
| Standard（Vectra - SillyTavern 標準向量格式）+ Hybrid | A2 |
| Qdrant（docker 上的專用向量資料庫） | A3 |

---

## ✨ 功能特性

### 🧬 EventBase — LLM 萃取的聊天記憶
LLM 將聊天摘要為結構化事件，帶有重要性/新近性/持續性權重。一個 4 權重的重新排序器決定哪些被注入。內建的去重機制會抑制已在近期訊息中可見的事件。

每個事件都是一筆結構化紀錄，不是原始文字。以下是 LLM 從 Astarion 購物時間窗產出的範例：

```
event_type:    item_acquired
importance:    6
text:          Tav and Astarion shopped for armor in Baldur's Gate. Astarion mocked the prices.
               Tav bought a leather chestpiece for 80gp.
DateTime:      1492-08-15T14:00:00
cause:         Tav needed better armor before the Gauntlet of Shar expedition
result:        Tav now wears the leather chestpiece; 80gp spent from party funds
characters:    [Tav, Astarion]
locations:     [Baldur's Gate, Sorcerous Sundries district]
factions:      []
items:         [leather chestpiece, 80gp]
concepts:      [armor shopping, party economy]
keywords:      [armor, leather, chestpiece, gold, shopping]
open_threads:  [Gauntlet of Shar preparation]
should_persist: false
```

兩種訊號（意義 + 關鍵字）都會在這組豐富欄位上運作，所以像「armor for the dungeon」這樣的查詢會透過 concepts/open_threads 命中，而「Astarion 80gp」則會透過 characters/items/keywords 命中。這個結構是 Qdrant 向量資料庫的原生格式，所以命中率比任何其他記憶擴充元件都要高得多。

### 🌏 CJK 語言支援（日文、韓文、繁體/簡體中文）
- Jieba WASM（簡體 + 繁體中文）、TinySegmenter（日文）、Intl.Segmenter（英文/拉丁/韓文）
- **每種語言專屬的停用詞列表** — 為日文、韓文、繁體中文、簡體中文（以及英文/拉丁）分別整理的字典。停用詞是像日文的「の・は・を」、中文的「的・地・得」、韓文的「의・은・는・을」這類處處出現卻幾乎沒有搜尋訊號的語法填充字。在關鍵字評分前剔除它們，是讓 CJK 內容上的 BM25 命中率維持高水準的關鍵——沒有這個處理，每個事件都會因為含有常見助詞而「匹配」你的查詢，把真正的訊號字詞淹沒。
- CJK 分詞器模式在 upsert 時**鎖定於每個 Qdrant 集合**——切換模式會顯示警告對話框

### 🔍 原生稀疏向量混合搜尋（Qdrant）
上方所述的 A3 路徑——伺服器端 RRF 加上全域準確的 BM25 IDF。每次查詢只需一次往返。

### 📝 儲存前先摘要
強制在向量儲存前進行 LLM 摘要。支援 OpenRouter 與本地的 vLLM 相容端點。可配置的提示詞範本。

### ⏯️ 更佳的向量化控制
停止按鈕、暫停/恢復、即使 Chrome 在執行中重啟也能保留的指紋快取。

### 🔒 每聊天集合範圍
新集合會自動為當前聊天啟用。「為當前聊天啟用」核取方塊控制聊天鎖定。資料庫瀏覽器中的鎖定按鈕會顯示鎖定是針對*此*聊天還是另一個。

### 📡 更聰明的狀態指示器
Auto-Sync 卡片顯示當前聊天是否已向量化以及有多少事件。World Info 卡片以名稱顯示已向量化的世界書。如果有缺失，兩者都會連結到正確的向量化器。

### 🗂️ 分頁介面
設定分為 **Core**（後端、嵌入、混合）、**EventBase**（聊天歷史/封存 .jsonl 聊天檔）、**ChunkBase**（世界書/文件/URL/wiki）、**Action**（診斷、開發工具）。

### ⚡ 平行視窗 — 向量化加速
向量化一個長聊天通常一次處理一個視窗：把視窗 1 送給 LLM → 等待 → 嵌入 → 送視窗 2 → 等待 → 嵌入 → …對於 2000 則訊息的聊天，這是大量的串列等待。

**平行視窗**滑桿（Vectorize Content 內的 Chunking Strategy 區段）讓你最多可以同時啟動 **8 個 LLM 萃取 + 嵌入呼叫**。視窗 1 正在被萃取時，視窗 2–8 也同時在進行中，大幅縮短總攝取時間。

| 滑桿值 | 行為 |
|---|---|
| **1（安全）** | 一次一個視窗。對供應商負載最低，無速率限制風險，最慢。 |
| **2–4** | 輕度平行。多數供應商的良好折衷。 |
| **5–8（快速）** | 積極平行。最適合速率限制較高的雲端供應商（OpenRouter、OpenAI、Cohere）。可能觸發免費方案的速率限制。 |

如果你在嚴格的速率限制免費方案或單一本地 GPU 上，使用 **1**。如果你在付費雲端供應商上，想要將 2000 則訊息的聊天從一小時縮短到幾分鐘攝取完成，請開到 **8**。

### 🧹 多語言關鍵字品質
CJK 的單字元過濾更好，針對高訊號的單字 RPG/日常生活/校園詞彙有模式特定的例外。

### 🧹 大規模清理
許多在混合後端搜尋、handle ID 過濾上的錯誤修復，以及來自原始 VectHare 的其他改進。

---

## 🎭 啟用規則

每個集合卡片都有一個啟用面板。優先順序鏈如下：

1. **停用**（暫停按鈕）→ 永不查詢
2. **觸發詞** → 關鍵字匹配近期訊息 → 啟用
3. **進階條件** → 如果觸發詞為空/未匹配，評估條件規則 → 啟用
4. **為當前聊天啟用 / 角色鎖定** → 手動永遠啟用的後備
5. **沒有匹配** → 不啟用

條件支援情緒（透過 Character Expressions 立繪偵測）、關鍵字、訊息/輪數計數，以及組合的 AND/OR 規則。

> ⚠️ **CJK 注意：** 觸發詞與情緒/關鍵字條件**僅支援英文**——關鍵字字典是英文的，且 regex 的 `\b` 詞邊界不會在 CJK 字元之間觸發。對於中文/日文/韓文故事，請改用**「為當前聊天啟用」/ 角色鎖定**。Message Count / Turn Count 條件是數值的，對任何語言都可正常運作。

---

## ⏳ 時間衰減

舊內容會得到較低的分數，所以只有真正相關時才會浮現。

```
relevance = original_score × (0.5 ^ (message_age / half_life))
```

half-life = 50 時：50 則之前的訊息為 50% 相關度，100 則之前為 25%，150 則之前為 12.5%。地板值（預設 0.3）防止完全遺忘。將重要片段標記為**對時間盲**使其免疫衰減。A3 路徑不需要使用此功能，因為使用 A3 路徑的整個重點就是讓後端搜尋完整資料庫而沒有效能損失。

> **EventBase 注意：** EventBase 在 4 權重重新排序器內建了自己的新近性加成。獨立的衰減設定只影響非聊天內容（世界書、文件）。

---

## 📦 後端

| 後端 | 適合 | 備註 |
|---|---|---|
| **Standard（Vectra - SillyTavern 預設向量格式）** | 小型資料集、多語言、入門 | 無依賴。僅限 A1/A2 混合。 |
| **Qdrant** | 大型聊天、多語言、生產用途 | A3 混合（最佳準確度）。需要 Qdrant + Similharity 插件（安裝方式見下方）。 |

任何需要超快與準確開發的場景都使用 **Qdrant 向量資料庫**——A3 的準確度顯著高於 A1/A2，特別是對 CJK，而且它免費且開源。資料庫中 2000+ 個事件的往返搜尋不到 3 秒。

---

## 💾 安裝

### 步驟 1：安裝擴充元件

1. 在瀏覽器中打開 SillyTavern
2. 前往 **Extensions** 面板（拼圖圖示）
3. 點擊 **"Install Extension"**
4. 貼上這個 URL：
   ```
   https://github.com/KritBlade/VectHarePlus
   ```
5. 點擊 **Install**

就這樣！VectHarePlus 會自動下載並啟用。

### 步驟 2：設定 VectHarePlus
1. 打開 **VectHarePlus Settings**（擴充元件面板的 Core 分頁）
2. 選擇你的向量儲存（Standard 或 Qdrant）
3. 選擇你的嵌入供應商（Transformers、OpenAI、Ollama、BananaBread 等）
4. 選擇你的摘要 LLM（Openrouter 或 vLLM）
5. 如果使用雲端供應商，請設定 API 金鑰
6. 在 Keyword Extraction 選擇你故事的語言。
7. 大多數設定使用預設值即可，但歡迎你調整。
8. 在 SillyTavern 中進入你的聊天，然後再次點擊 VectHarePlus 擴充元件。你**必須**點擊 "Vectorize Content" 並選擇 Chat History 來向量化你的第一個 db。
9. 如有需要，在 AutoSync 分頁啟用 Auto-Sync，頻率在 EventBase 分頁下的 "Extraction > Window Size" 設定
10. 如有需要，在 WorldInfo 分頁向量化你的世界書/World Info。

### 步驟 3：（僅 Qdrant 後端需要）安裝 Similharity 插件

```bash
在 Windows 上開啟命令提示字元，或在 Linux/Mac 上開啟終端機，或如果你在 docker 上請進入 Console
cd SillyTavern/plugins
git clone -b Similharity-Plugin https://github.com/KritBlade/VectHarePlus.git similharity
cd similharity
npm install
```

在 `config.yaml` 中搜尋以下鍵並改為 true：（Windows 會在 SillyTavern\config.yaml，而 Linux/Mac 應該在 SillyTavern\config\config.yaml）
```yaml
enableServerPlugins: true
```

重啟 SillyTavern。

---

## 🔄 自動更新

VectHarePlus 的 manifest 中設定了 `auto_update: true`。如果你透過 `git clone` 安裝，SillyTavern 會自動檢查並套用更新！

請留意 Extensions 面板中的更新通知，或用「Check for Updates」按鈕手動檢查。

Qdrant 後端需要將 enableServerPlugin 設為 true。

---

## ❓ 常見問題

**為什麼底層有兩條獨立的管線？**
在內部，VectHarePlus 會根據內容類型把內容路由到兩條檢索路徑之一：

| 管線 | 處理什麼 |
|---|---|
| **EventBase** | 你的聊天歷史（即時聊天 + 上傳的 `.jsonl` 封存） |
| **Standard（Chunk）** | 其他所有內容：世界書、角色卡、URL、文件、wiki 頁面、YouTube 字幕 |

它們永遠看不到彼此的內容——所以同一則聊天訊息不會被檢索兩次（一次作為事件，一次作為原始片段）。你通常不需要思考這件事；這代表 EventBase 負責聊天，而標準片段管線負責其他所有內容。

**我可以在聊天中途更改 CJK 分詞器模式嗎？**
不行——別這樣做。CJK 分詞器模式在 upsert 時透過哨兵點**鎖定於每個 Qdrant 集合**。在你已經向量化內容後切換模式，會在下一次查詢時觸發「分詞器不匹配」警告對話框，你真正的選項只有：
1. **還原**到原始模式（保留現有向量），或
2. **從頭開始重新向量化集合**（丟掉所有已萃取的事件並從新開始）。

在你開始向量化聊天**之前**就選好分詞器模式，並堅持下去。沒有原地遷移——稀疏向量是用原始模式分詞的，所以與不同分詞器的輸出不相容。在你開始向量化聊天**之前**也請選好你的嵌入模型並堅持下去。

**為什麼 EventBase 忽略我的時間衰減設定？**
EventBase 在 4 權重重新排序器中內建了自己的新近性加成。獨立的時間衰減設定僅套用於非聊天內容（世界書、文件）。這是刻意的——同時套用兩者會對聊天事件造成雙重衰減。

**我可以在中/日/韓聊天上使用觸發詞/情緒條件嗎？**
不可靠。關鍵字字典僅支援英文，且 regex 的 `\b` 詞邊界不會在 CJK 字元之間觸發。改用「為當前聊天啟用」/ 角色鎖定，或數值的 Message Count / Turn Count 條件。

**為什麼找不到「scene」設定？原本的 VectHare 有這個**
Scene 支援已被移除（它是基於切塊的聊天時代的功能，而聊天現在透過 EventBase 執行）。把事件聚合在一起不太合邏輯，所以這個功能被移除了。

---

## 🐛 疑難排解

**"No embeddings available"** — 在 ST 主要設定中啟用 Vectors 擴充元件，選擇一個嵌入供應商，如有需要加入 API 金鑰，執行 Diagnostics。

**事件/片段沒有被檢索到** — 點擊 Vectorize 進行索引，降低分數門檻（試試 0.3），確認集合是「為當前聊天啟用」或有匹配的觸發詞。

**"Backend health check failed"** — 在 Qdrant 上，確認 Qdrant 伺服器正在運行且已安裝 Similharity 插件。

**效能緩慢** — 切換到 Qdrant + A3（單次往返、伺服器端融合）。減少 EventBase Top K。使用 API 嵌入供應商（平行）而非本地 GPU（串列）。

**記憶遺漏重要細節** — 將重要片段標記為對時間盲、提高衰減地板值、加入觸發關鍵字（僅限英文內容）。

---

## 🙏 致謝

**VectHarePlus** 從 VectHare 分支而來，原作者為 **Coneja Chibi**。感謝 SillyTavern 社群的回饋與測試。

GPLv3 授權 — 請見 LICENSE。

---

*"Lets make your memory hardcore!."* 🐰✨
