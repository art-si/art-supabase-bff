import { bffSession } from "@/api/bff"
export const useAuth = () => {
 const hasAuth = (code: string): boolean => bffSession.value?.permissions.includes(code) === true
 return { hasAuth, hasAnyAuth: (codes: string[]) => codes.some(hasAuth), hasAllAuth: (codes: string[]) => codes.every(hasAuth) }
}
