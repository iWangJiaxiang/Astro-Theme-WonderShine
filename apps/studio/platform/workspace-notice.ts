export function workspaceCommitNotice(sync: 'none' | 'pending' | 'unconfirmed'): string {
  if (sync === 'pending') return '已提交到设备。';
  if (sync === 'unconfirmed') return '本地提交已保留；远端同步结果尚未确认，请核实远端状态后再继续。';
  return '已提交到设备，尚未推送到远端。';
}
