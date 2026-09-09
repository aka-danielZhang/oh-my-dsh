/** Pure projection from the Host's allowlisted flat index to nested UI rows. */

import type { MemoryTreeSnapshot } from '../manager-contract.ts'

export interface MemoryFolderNode {
  type: 'folder'
  path: string
  name: string
  children: MemoryTreeNode[]
}

export interface MemoryFileNode {
  type: 'file'
  path: string
  name: string
  file: MemoryTreeSnapshot['files'][number]
}

export type MemoryTreeNode = MemoryFolderNode | MemoryFileNode

/** Build stable alphabetical folders while retaining the Host's file payload. */
export function buildMemoryTree(files: MemoryTreeSnapshot['files']): MemoryTreeNode[] {
  const roots: MemoryTreeNode[] = []
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const segments = file.path.split('/')
    let children = roots
    let parent = ''
    for (const segment of segments.slice(0, -1)) {
      const path = parent.length === 0 ? segment : `${parent}/${segment}`
      let folder = children.find((node): node is MemoryFolderNode => node.type === 'folder' && node.path === path)
      if (folder === undefined) {
        folder = { type: 'folder', path, name: segment, children: [] }
        children.push(folder)
      }
      children = folder.children
      parent = path
    }
    children.push({
      type: 'file',
      path: file.path,
      name: file.label || segments.at(-1) || file.name,
      file,
    })
  }
  sortNodes(roots)
  return roots
}

function sortNodes(nodes: MemoryTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  for (const node of nodes) if (node.type === 'folder') sortNodes(node.children)
}
