import React, { useCallback, useRef, useState } from 'react';
import { Check } from 'lucide-react';

const ToastContext = React.createContext(() => {});
// This module intentionally co-locates the provider and hook for the toast boundary.
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => React.useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const show = useCallback((message, type = 'success') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, type });
    timer.current = setTimeout(() => setToast(null), 3400);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={16} color="var(--accent)" /> : '⚠️'}
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}
