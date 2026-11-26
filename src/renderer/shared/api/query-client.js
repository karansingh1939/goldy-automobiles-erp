import { QueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store/use-app-store.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      // The API runs on this laptop, so reloading is instant. Always show fresh
      // numbers when a screen opens, e.g. Home right after a bill is cancelled.
      staleTime: 0,
    },
    mutations: {
      onError: (error) => {
        const msg = error?.response?.data?.error?.message || error.message || 'Operation failed.';
        useAppStore.getState().addNotification(msg, 'error');
      },
    },
  },
});

useAppStore.subscribe((state, previous) => {
  if (state.token !== previous.token) queryClient.clear();
});
