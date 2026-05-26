# SigMap Query Context
Generated: 2026-05-26T10:45:59.132Z

## core\core-vector-api.js
```
class DynamicRateLimiter
constructor()
async execute(fn, settings) → Promise<any>
if(maxCalls <= 0)
if(this.timestamps.length >= maxCalls)
if(waitTime > 0)
export function getVectorsRequestBody(args = {}, settings) → object
export async function getAdditionalArgs(items, settings, onProgress = null) → Promise<object>
export function throwIfSourceInvalid(settings)
export async function getSavedHashes(collectionId, settings, includeMetadata = false) → Promise<number[]|{hashes:
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) → Promise<void>
export async function deleteVectorItems(collectionId, hashes, settings) → Promise<void>
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) → Promise<{ hashes: number[
export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) → Promise<Record<string, {
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) → Promise<Record<string, {
export async function purgeVectorIndex(collectionId, settings) → Promise<boolean>
export async function purgeFileVectorIndex(collectionId, settings) → Promise<void>
export async function purgeAllVectorIndexes(settings) → Promise<void>
export async function listChunks(collectionId, settings, options = {}) → Promise<{items: Array<{ha
export async function updateChunkText(collectionId, hash, newText, settings)
```

## ui\search-debug.js
```
export function createDebugData() → SearchDebugData
export function addTrace(debugData, stage, action, details = {})
export function recordChunkFate(debugData, hash, stage, fate, reason = null, data = {})
export function setLastSearchDebug(data)
export function getQueryHistory() → Array<SearchDebugData>
export function getLastSearchDebug() → SearchDebugData|null
export function openSearchDebugModal()
export function closeSearchDebugModal()
export function openQueryTestModal()
function createModalHtml(data, historyIndex = 0) → string
function createPipelineStage(label, count, fromCount, icon, colorClass, disabled = false)
function createKeywordBoostStage(data)
function renderStageChunks(chunks, stageName, data)
function getExclusionStatus(chunk, currentStage, data)
function buildScoreBreakdown(chunk)
function renderInjectionVerification(data)
function renderCriticalFailure(data)
function diagnosePipeline(data) → Array<{label: string, det
function truncateText(text, maxLength)
function renderExcludedAnalysis(data)
```

## core\eventbase-schema.js
```
export class EventBaseExtractionError
constructor(message, windowIndex = -1)
export class EventBaseFatalError
constructor(message, code = 'fatal')
export function validateEvent(raw) → { ok: boolean, errors: st
export function buildEmbedText(event) → string
export function parseEmbedText(text) → object
export function buildExtractionPrompt(text, maxCount, customPrompt = '', mode = 'intl') → string
function ensureArray(val) → string[]
function ensureDateTime(raw, errors) → string|null
```

## core\agentic-retrieval.js
```
export async function retrieveEventsWithAgent(params) → Promise<{events: object[]
export function _resolveAgenticLLMConfig(settings = {})
export function _validatePlannerFilters(raw, settings)
async function _callPlanner({ systemPrompt, userMessage, llmCfg, timeoutMs })
function _getRecentChatForPlanner(settings)
function _firstNWords(text, n)
function _validateAndTrimQueries(queries, maxQueries)
```

## core\collection-ids.js
```
export function normalizeBackendForId(backend) → string
export function getBackendFromCollectionId(collectionId) → string|null
export function remapCollectionIdToBackend(collectionId, targetBackend) → string
export function getRegistryBackend(vectorBackend) → string
export function buildRegistryKey(collectionId, settingsOrBackend) → string
export function resolveBackendForCollection(input) → { backend: string|null, c
export function getChatUUID() → string|null
export function buildLorebookCollectionId(lorebookName, backend, timestamp) → string
export function buildCharacterCollectionId(characterName, backend, timestamp) → string
export function buildDocumentCollectionId(documentName, backend, timestamp) → string
export function buildEventBaseCollectionId(chatUUID, backend) → string|null
export function buildArchiveEventCollectionId({ filenameCharName, archiveUUID, backend }) → string|null
export function parseCollectionId(collectionId) → {type: string, rawId: str
export function buildChatSearchPatterns(chatId, chatUUID) → string[]
export function matchesPatterns(collectionId, patterns) → boolean
export function parseRegistryKey(registryKey) → {backend: string|null, so
function _sanitizeNameSegment(name, maxLength)
function _currentHandleId()
```
