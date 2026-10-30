import { createContext, useContext } from 'react'

export const YardOpsContext = createContext<HTMLElement | null>(null)

export function useYardOps() {
  return useContext(YardOpsContext)
}
