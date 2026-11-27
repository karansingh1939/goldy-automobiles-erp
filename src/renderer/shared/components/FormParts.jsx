import React from 'react';
import { X, Edit2, Trash2 } from 'lucide-react';

const inputClass =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800 text-sm focus-ring text-gray-950 dark:text-white';

/** Labelled text input used by the record forms (customers, suppliers, vehicles). */
export function TextField({ id, label, className = '', inputClassName = '', ...inputProps }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-semibold text-gray-600 dark:text-gray-400">
        {label}
      </label>
      <input id={id} type="text" className={`${inputClass} ${inputClassName}`} {...inputProps} />
    </div>
  );
}

// Full class names so Tailwind keeps them in the build.
const SIZES = {
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
};

/** Centered pop-up with a title row and a close button. */
export function Modal({ title, icon: Icon, onClose, size = 'lg', children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div
        className={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl ${SIZES[size]} w-full shadow-2xl overflow-hidden animate-slide-up`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400">
            {Icon && <Icon className="h-5 w-5" />}
            <h3 className="text-lg font-bold">{title}</h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Cancel and Save buttons at the bottom of a record form. */
export function FormButtons({ onCancel, saving, saveLabel = 'Save' }) {
  return (
    <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving}
        className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50 transition-colors"
      >
        {saveLabel}
      </button>
    </div>
  );
}

/** Edit and Delete icon buttons for a table row. */
export function RowActions({ onEdit, onDelete, disabled }) {
  const button =
    'p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-gray-500 disabled:opacity-30 transition-colors';
  return (
    <div className="flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        title="Edit"
        aria-label="Edit"
        className={`${button} hover:text-brand-650`}
      >
        <Edit2 className="h-4.5 w-4.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={disabled}
        title="Delete"
        aria-label="Delete"
        className={`${button} hover:text-red-650`}
      >
        <Trash2 className="h-4.5 w-4.5" />
      </button>
    </div>
  );
}
