/* 读取宿主右栏占位，避免dsh-papercover抽屉和官方侧栏重叠。 */
/** Return the width occupied at the right edge by the DSH sidebar. */
export function officialRightInset(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 0
  const frame = document.querySelector<HTMLElement>('[data-dsh-frame]')
  if (frame?.hasAttribute('data-rightbar-fullscreen')) {
    return Math.round(frame.getBoundingClientRect().width || window.innerWidth)
  }
  const column = document.querySelector<HTMLElement>('[data-rightbar-col]')
  if (column !== null) {
    const width = Math.round(column.getBoundingClientRect().width)
    if (width >= 40) return width
  }
  const panel = document.querySelector<HTMLElement>('[data-sidebar-right-panel][data-sidebar-right-open]')
  if (panel !== null) {
    const rect = panel.getBoundingClientRect()
    const frameRight = frame?.getBoundingClientRect().right ?? window.innerWidth
    if (rect.width >= 160 && rect.height > window.innerHeight * 0.3 && Math.abs(frameRight - rect.right) < 12) {
      return Math.round(rect.width)
    }
  }
  return 0
}
