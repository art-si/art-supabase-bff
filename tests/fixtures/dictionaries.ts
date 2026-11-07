/** Sanitized dictionary API data for business workflow tests. */
const dictionaries = [
  {
    code: 'commonBoolean',
    name: '是否',
    options: [
      {
        value: 'true',
        label: '是'
      },
      {
        value: 'false',
        label: '否'
      }
    ]
  },
  {
    code: 'bffRuntimeEnvironment',
    name: '运行环境',
    options: [
      {
        value: 'development',
        label: '开发环境'
      },
      {
        value: 'staging',
        label: '预发布环境'
      },
      {
        value: 'production',
        label: '生产环境'
      }
    ]
  },
  {
    code: 'bffApplicationStatus',
    name: '应用状态',
    options: [
      {
        value: 'true',
        label: '启用'
      },
      {
        value: 'false',
        label: '停用'
      }
    ]
  },
  {
    code: 'bffMemberAccessStatus',
    name: '成员访问状态',
    options: [
      {
        value: 'enabled',
        label: '已启用'
      },
      {
        value: 'disabled',
        label: '已停用'
      }
    ]
  },
  {
    code: 'bffMemberRole',
    name: '平台身份',
    options: [
      {
        value: 'viewer',
        label: '普通成员'
      },
      {
        value: 'admin',
        label: '平台管理员'
      }
    ]
  },
  {
    code: 'bffUpstreamStatus',
    name: '上游运行状态',
    options: [
      {
        value: 'draft',
        label: '草稿'
      },
      {
        value: 'active',
        label: '已启用'
      },
      {
        value: 'disabled',
        label: '已停用'
      }
    ]
  },
  {
    code: 'bffUpstreamAuthType',
    name: '上游认证方式',
    options: [
      {
        value: 'none',
        label: '无认证'
      },
      {
        value: 'bearer',
        label: 'Bearer Token'
      },
      {
        value: 'api_key_header',
        label: 'API Key 请求头'
      }
    ]
  },
  {
    code: 'bffCredentialAction',
    name: '凭据操作',
    options: [
      {
        value: 'rotate',
        label: '轮换凭据'
      },
      {
        value: 'clear',
        label: '清除凭据'
      }
    ]
  },
  {
    code: 'bffInterfaceMethod',
    name: '接口请求方法',
    options: [
      {
        value: 'GET',
        label: 'GET'
      },
      {
        value: 'POST',
        label: 'POST'
      },
      {
        value: 'PUT',
        label: 'PUT'
      },
      {
        value: 'PATCH',
        label: 'PATCH'
      },
      {
        value: 'DELETE',
        label: 'DELETE'
      }
    ]
  },
  {
    code: 'bffInterfaceValidationStatus',
    name: '接口验证状态',
    options: [
      {
        value: 'unvalidated',
        label: '待验证'
      },
      {
        value: 'valid',
        label: '已通过'
      },
      {
        value: 'invalid',
        label: '未通过'
      }
    ]
  },
  {
    code: 'bffInterfaceInputLocation',
    name: '接口输入位置',
    options: [
      {
        value: 'path',
        label: '路径参数'
      },
      {
        value: 'query',
        label: '查询参数'
      },
      {
        value: 'body',
        label: '请求体'
      }
    ]
  },
  {
    code: 'bffInterfaceValueType',
    name: '接口字段类型',
    options: [
      {
        value: 'string',
        label: '文本'
      },
      {
        value: 'number',
        label: '数字'
      },
      {
        value: 'boolean',
        label: '布尔值'
      }
    ]
  },
  {
    code: 'bffInterfaceBindingSource',
    name: '接口映射来源',
    options: [
      {
        value: 'input',
        label: '接口输入'
      },
      {
        value: 'step',
        label: '前序步骤'
      },
      {
        value: 'literal',
        label: '固定值'
      }
    ]
  }
]

export function dictionarySnapshot() {
  return {
    revision: 1,
    types: dictionaries.map((dictionary, index) => ({
      id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      nodeType: 'dictionary',
      code: dictionary.code,
      name: dictionary.name,
      status: '1'
    })),
    items: dictionaries.flatMap((dictionary, index) =>
      dictionary.options.map((option, sort) => ({
        id: `80000000-0000-4000-8000-${String(index * 100 + sort + 1).padStart(12, '0')}`,
        typeId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ...option,
        sort,
        status: '1',
        i18nScope: '1',
        dictTypeTable: { code: dictionary.code, name: dictionary.name }
      }))
    )
  }
}
