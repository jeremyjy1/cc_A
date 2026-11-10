import type { ModelOption } from '../utils/model/modelOptions'
import { validModel } from './inference'

export function parseModelCatalog(data: string): ModelOption[] {
  const rows = JSON.parse(data)
  if (!Array.isArray(rows) || !rows.length || rows.length > 256) throw Error('Invalid C model list')
  const clean = (s: unknown) => typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : ''
  const seen = new Set<string>()
  const options: ModelOption[] = []
  for (const row of rows) {
    if (typeof row?.value !== 'string' || !validModel(row.value) || seen.has(row.value)) continue
    seen.add(row.value)
    options.push({value:row.value === 'default' ? null : row.value, label:clean(row.displayName) || row.value, description:clean(row.description)})
  }
  if (!options.length) throw Error('Empty C model list')
  if (!seen.has('default')) options.unshift({value:null,label:'C 池默认模型',description:''})
  return options
}
