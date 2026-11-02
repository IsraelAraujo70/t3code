import { createContext } from "react";
export const NoteEdit = createContext<((id: string, text: string) => void) | undefined>(undefined);
