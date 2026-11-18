import type { PublicSettings, SettingsPatch } from '@shared/types'

export interface PaneProps {
  s: PublicSettings
  patch: (p: SettingsPatch, immediate?: boolean) => void
}
