/**
 * Ask retrieval: page-range forcing so method pages are not dropped by keyword top-k.
 * Run: node --experimental-strip-types tests/ask-retrieve.mjs
 */
import assert from 'node:assert/strict'
import {
  parseRequestedPages,
  chunksCoveringPages,
  selectAskChunks,
  isSequentialWalkIntent,
  pageMarkersInChunk,
} from '../src/read/ask-retrieve.ts'

assert.deepEqual(parseRequestedPages('请讲第5–6页'), [5, 6])
assert.deepEqual(parseRequestedPages('第9到11页逐段讲解'), [9, 10, 11])
assert.deepEqual(parseRequestedPages('看看第5、6页和 Algorithm 1'), [5, 6])
assert.deepEqual(parseRequestedPages('pages 9-11 please'), [9, 10, 11])
assert.deepEqual(parseRequestedPages('只要第8页'), [8])
assert.equal(isSequentialWalkIntent('请逐段讲解方法部分'), true)
assert.equal(isSequentialWalkIntent('CMA-ES 步长怎么选'), false)

const chunks = [
  '【第1页】title abstract intro',
  '【第3页】related work mapping',
  '【第5页】discrete\n【第6页】continuous GP kalman',
  '【第7页】altitude sensor fig3',
  '【第9页】grid search\n【第10页】CMA-ES optimization',
  '5.5.1 Adaptivity for regions of interest utility equation eleven', // continuation → p11
  '【第12页】experiments continuous',
]

assert.deepEqual(pageMarkersInChunk(chunks[4]), [9, 10])
assert.deepEqual(chunksCoveringPages(chunks, [5, 6]), [2])
assert.deepEqual(chunksCoveringPages(chunks, [9, 10, 11]), [4, 5])

const picked = selectAskChunks(chunks, '请对第9—11页做逐段讲解，说明路径规划与效用函数')
assert.ok(picked.includes(4), `expected chunk 4 (p9-10), got ${picked}`)
assert.ok(picked.includes(5), `expected chunk 5 (p11 continuation), got ${picked}`)

const picked56 = selectAskChunks(chunks, '第5-6页的离散与连续建图分别怎么做')
assert.ok(picked56.includes(2), `expected chunk 2 (p5-6), got ${picked56}`)

// Regression: keyword-only used to miss page hits when scoring drifted — page force still wins
const sparse = selectAskChunks(
  [
    '【第1页】cars parking lot temperature weeds farmland',
    '【第8页】Algorithm 1 replan path procedure waypoints',
    '【第9页】CMA-ES lattice utility Shannon entropy',
    'unmarked continuation of planning objective regions of interest',
    '【第12页】Table 1 Tr(P) RMSE coverage spiral',
  ],
  '第9-11页的路径规划目标函数与自适应兴趣区域',
)
assert.ok(sparse.includes(2), `page force must keep p9 chunk: ${sparse}`)
assert.ok(sparse.includes(3), `page force must keep p11 continuation: ${sparse}`)

console.log('ask-retrieve: ok')
