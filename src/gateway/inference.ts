import type { AppState } from '../state/AppStateStore'

export type InferenceOptions = { model?: string; effort?: string }

export function validModel(model: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?:\[1m\])?$/.test(model) && !/\s/.test(model)
}

export function validateInference({ model, effort }: InferenceOptions) {
  if (model !== undefined && !validModel(model)) throw Error('Invalid model ID')
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw Error('Choose low, medium, high, xhigh, max or auto for effort')
  }
}

export function sessionInference(state: AppState): InferenceOptions {
  return {
    model: state.mainLoopModelForSession ?? state.mainLoopModel ?? undefined,
    effort: typeof state.effortValue === 'string' ? state.effortValue : undefined,
  }
}
