// Protocol utility tools registered by AgentTransport, also exposed in the management catalogue.
export const protocolTools = [
  {
    name: 'state_get',
    description: '读取当前账目并发版本，作为下一次写入的 expectedState。',
    scope: 'read',
  },
  {
    name: 'operation_get',
    description: '查询本连接发起的草稿、确认状态和最终结果。',
    scope: 'read',
  },
  {
    name: 'file_upload_request',
    description: '请求受保护的私有图标上传入口，不直接修改账目。',
    scope: 'write',
  },
  { name: 'file_status', description: '查询本连接上传文件状态和导入预检。', scope: 'read' },
  { name: 'icon_image', description: '请求受保护的图标图片读取入口。', scope: 'read' },
  { name: 'connection_info', description: '查看本连接权限、期限和隐藏账户授权。', scope: 'read' },
  {
    name: 'connection_revoke',
    description: '撤销本连接；只读权限下也可主动撤销自身。',
    scope: 'read',
  },
] as const;
export const tokenDays = [1, 3, 7, 30, 365] as const;
