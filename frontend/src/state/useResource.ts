import { useCallback, useEffect, useRef, useState } from 'react';
import { TripwireApiError } from '../api';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: TripwireApiError | null;
}

const IDLE: Resource<never> = { data: null, loading: false, error: null };

export interface ResourceHandle<T> extends Resource<T> {
  reload: () => void;
  /** Lets a mutation push a confirmed server payload in without a second round-trip. */
  set: (data: T) => void;
}

/**
 * Loads one thing. Keeps the previous payload visible while reloading so panels
 * do not flash empty on every refresh, and converts any thrown value into a
 * typed error the UI can render honestly.
 */
export function useResource<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): ResourceHandle<T> {
  const [state, setState] = useState<Resource<T>>(IDLE as Resource<T>);
  const [nonce, setNonce] = useState(0);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setState(IDLE as Resource<T>);
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fnRef.current().then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error:
            error instanceof TripwireApiError
              ? error
              : new TripwireApiError(0, 'internal_error', String((error as Error)?.message ?? error)),
        });
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((data: T) => setState({ data, loading: false, error: null }), []);

  return { ...state, reload, set };
}

export interface MutationState {
  busy: boolean;
  error: TripwireApiError | null;
}

/** Tracks a one-shot user action (trigger, reset, review) with honest busy/error state. */
export function useMutation() {
  const [state, setState] = useState<MutationState>({ busy: false, error: null });

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setState({ busy: true, error: null });
    try {
      const result = await action();
      setState({ busy: false, error: null });
      return result;
    } catch (error) {
      setState({
        busy: false,
        error:
          error instanceof TripwireApiError
            ? error
            : new TripwireApiError(0, 'internal_error', String((error as Error)?.message ?? error)),
      });
      return null;
    }
  }, []);

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, run, clearError };
}
