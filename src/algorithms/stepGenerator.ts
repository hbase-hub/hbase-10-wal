/**
 * WAL 预写日志 — 步骤生成器
 *
 * 动画展示 HBase WAL（Write-Ahead Log）机制：写请求先以顺序写追加到
 * WAL 文件（WALEdit），再 fsync 持久化到 HDFS（3 副本），随后才写
 * MemStore；RegionServer 宕机后通过回放 WAL 恢复尚未 flush 的数据。
 */
import type { Step, VisualElement, VariableState } from '../types'

/** WAL 预写日志伪代码 */
export const TEMPLATE_CODE = `// WAL 写路径：先追加、再 sync、最后写 MemStore
WAL wal = regionServer.getWAL(region);            // 获取 Region 的 WAL
long seq = wal.startCacheFlush();                 // 分配序列号
wal.append(seq, region, edits, scopes);           // 追加 WALEdit（顺序写）
wal.sync();                                        // fsync 持久化到 HDFS（3副本）
memStore.add(edits);                              // 最后才写 MemStore

// 宕机恢复：回放 WAL 重建未 flush 的 MemStore
WALPlayer player = new WALPlayer(wal);
while (player.hasNext()) {
    WALEdit e = player.next();
    memStore.add(e);                              // 重放未落盘的编辑
}`

// 画布布局常量
const LAYOUT = {
  client: { x: 50, y: 80, w: 110, h: 60, label: 'Client' },
  rs: { x: 200, y: 80, w: 150, h: 60, label: 'RegionServer' },
  wal: { x: 400, y: 40, w: 170, h: 70, label: 'WAL (edits.log)' },
  hdfs: { x: 640, y: 40, w: 160, h: 70, label: 'HDFS (3 replicas)' },
  memstore: { x: 400, y: 160, w: 170, h: 70, label: 'MemStore' },
  recover: { x: 200, y: 250, w: 180, h: 70, label: 'WALPlayer' },
}

function makeElements(highlight?: string): VisualElement[] {
  const mk = (
    key: keyof typeof LAYOUT,
    type: string,
    state: string,
    sub?: string
  ): VisualElement => {
    const l = LAYOUT[key]
    return {
      id: key,
      type,
      label: l.label,
      subLabel: sub,
      x: l.x,
      y: l.y,
      width: l.w,
      height: l.h,
      state: key === highlight ? 'active' : state,
    }
  }
  return [
    mk('client', 'client', 'idle'),
    mk('rs', 'rs', 'idle'),
    mk('wal', 'wal', 'idle', 'seq=42'),
    mk('hdfs', 'hdfs', 'idle', 'replicas=3'),
    mk('memstore', 'memstore', 'idle'),
    mk('recover', 'rs', 'idle', 'replay'),
  ]
}

export function generateSteps(): Step[] {
  const steps: Step[] = []
  let idx = 0

  const push = (
    desc: string,
    line: number,
    vars: VariableState[],
    elements: VisualElement[],
    arrows: { from: string; to: string; label?: string }[] = [],
    actionLabel?: string,
    statusText?: string
  ) => {
    steps.push({
      index: idx++,
      description: desc,
      currentLine: line,
      variables: vars,
      elements,
      connections: arrows.map((a, i) => ({
        id: `arrow-${i}`,
        fromId: a.from,
        toId: a.to,
        kind: 'arrow' as const,
        label: a.label,
      })),
      annotations: [],
      actionLabel,
      statusText: statusText ?? desc,
    })
  }

  // 步骤 0：WAL 拓扑总览
  push(
    'WAL：写请求先追加 WAL(顺序写) -> fsync 到 HDFS(3副本) -> 才写 MemStore，保证宕机可恢复',
    0,
    [
      { name: 'seqNum', value: '42', line: 3, type: 'long' },
      { name: 'walFile', value: 'edits.log', line: 1, type: 'WAL' },
      { name: 'replicas', value: '3', line: 5, type: 'int' },
    ],
    makeElements(),
    [
      { from: 'rs', to: 'wal', label: 'append' },
      { from: 'wal', to: 'hdfs', label: 'sync' },
    ],
    'OVERVIEW',
    'WAL 总览'
  )

  // 步骤 1：获取 WAL 与序列号
  push(
    'RegionServer 为 Region 获取 WAL，并分配单调递增的序列号 seq',
    2,
    [
      { name: 'wal', value: 'edits.log', line: 1, type: 'WAL' },
      { name: 'seq', value: '42', line: 2, type: 'long' },
    ],
    makeElements('rs'),
    [{ from: 'rs', to: 'wal', label: '1.getWAL' }],
    'WAL-GET',
    '获取 WAL'
  )

  // 步骤 2：追加 WALEdit（顺序写，快）
  push(
    '将 WALEdit 以顺序写追加到 WAL 文件（顺序写比随机写快，吞吐高）',
    4,
    [
      { name: 'edits', value: '[{r:1,op:PUT}]', line: 4, type: 'WALEdit' },
      { name: 'wal.append', value: 'seq=42', line: 4, type: 'long' },
    ],
    makeElements('wal'),
    [{ from: 'rs', to: 'wal', label: '2.append(顺序写)' }],
    'APPEND',
    '追加 WALEdit'
  )

  // 步骤 3：fsync 持久化到 HDFS（3 副本）
  push(
    'wal.sync() 触发 fsync，将编辑持久化到 HDFS（默认 3 副本），落盘前数据不安全',
    5,
    [
      { name: 'synced', value: 'true', line: 5, type: 'boolean' },
      { name: 'hdfs', value: '3 replicas', line: 5, type: 'HDFS' },
    ],
    makeElements('hdfs'),
    [{ from: 'wal', to: 'hdfs', label: '3.sync(fsync)' }],
    'SYNC',
    'fsync 到 HDFS'
  )

  // 步骤 4：最后才写 MemStore
  push(
    'WAL 落盘后才写 MemStore——若此时宕机，WAL 可重放恢复，绝不丢已确认数据',
    6,
    [
      { name: 'memStore', value: '[r:1]', line: 6, type: 'MemStore' },
      { name: 'durability', value: 'guaranteed', line: 6, type: 'boolean' },
    ],
    makeElements('memstore'),
    [{ from: 'rs', to: 'memstore', label: '4.add(最后)' }],
    'MEMSTORE',
    '写 MemStore'
  )

  // 步骤 5：宕机场景
  push(
    'RegionServer 宕机：MemStore 中未 flush 的数据丢失，但 WAL 已落盘',
    9,
    [
      { name: 'crash', value: 'RS down', line: 9, type: 'event' },
      { name: 'wal', value: 'edits.log (持久)', line: 5, type: 'WAL' },
    ],
    makeElements('hdfs'),
    [],
    'CRASH',
    '宕机'
  )

  // 步骤 6：WAL 回放恢复
  push(
    'WALPlayer 顺序读取 WAL，回放每条 WALEdit 重建未落盘的 MemStore',
    12,
    [
      { name: 'player', value: 'replaying...', line: 10, type: 'WALPlayer' },
      { name: 'memStore', value: 'replay -> [r:1]', line: 12, type: 'MemStore' },
    ],
    makeElements('recover'),
    [{ from: 'wal', to: 'recover', label: '5.读WAL' }],
    'REPLAY',
    '回放 WAL'
  )

  // 步骤 7：恢复完成
  push(
    '回放完成：未 flush 的数据已重建到 MemStore，随后正常 flush 落盘',
    13,
    [
      { name: 'result', value: 'recovered: r1->v', line: 13, type: 'byte[]' },
      { name: 'dataLoss', value: 'false', line: 13, type: 'boolean' },
    ],
    makeElements('recover').map((e) => ({
      ...e,
      state: e.id === 'recover' ? 'done' : e.state,
    })),
    [{ from: 'recover', to: 'memstore', label: '6.重建' }],
    'DONE',
    '恢复完成'
  )

  return steps
}
