import { createContext, use, useMemo, useState, type ReactNode } from 'react';

import type { AmbientInput } from './ambient-model';

type AmbientApi = { setTitle: (title: AmbientInput | null) => void };

const TitleContext = createContext<AmbientInput | null>(null);
const ApiContext = createContext<AmbientApi>({ setTitle: () => {} });

/** Holds the title that paints the room: focused (TV) or hovered/active (web, phone). */
export function AmbientProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<AmbientInput | null>(null);
  const api = useMemo(() => ({ setTitle }), []);
  return (
    <ApiContext value={api}>
      <TitleContext value={title}>{children}</TitleContext>
    </ApiContext>
  );
}

export function useAmbientTitle(): AmbientInput | null {
  return use(TitleContext);
}

/** Setter for cards: call on focus (TV), hover (web) or when a title becomes active (phone). */
export function useSetAmbient(): AmbientApi['setTitle'] {
  return use(ApiContext).setTitle;
}
