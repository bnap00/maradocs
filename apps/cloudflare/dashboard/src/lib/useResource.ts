import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((prev: T | undefined) => T | undefined)) => void;
}

/** Load async data; stale responses are dropped when deps change. */
export function useResource<T>(load: () => Promise<T>, deps: DependencyList): Resource<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async (background: boolean) => {
    const id = ++seq.current;
    if (!background) setLoading(true);
    try {
      const result = await loadRef.current();
      if (id !== seq.current) return;
      setDataState(result);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setError(err);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // `seq` is a request counter, not a DOM ref: bumping it on cleanup drops
    // responses that belong to the previous deps.
    const counter = seq;
    setDataState(undefined);
    void run(false);
    return () => {
      counter.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => run(true), [run]);
  const setData = useCallback(
    (updater: T | ((prev: T | undefined) => T | undefined)) =>
      setDataState((prev) =>
        typeof updater === "function"
          ? (updater as (p: T | undefined) => T | undefined)(prev)
          : updater,
      ),
    [],
  );
  return { data, error, loading, reload, setData };
}
