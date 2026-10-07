'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TagInfo } from '@/types';

interface BulkActionsProps {
  selectedCount: number;
  tags: TagInfo[];
  onBulkTag: (tagIds: number[], mode: 'add' | 'replace') => Promise<void>;
  onBulkDelete: () => Promise<void>;
  onDeselectAll: () => void;
}

/**
 * Bulk action bar shown when highlights are selected.
 * Supports bulk tagging (add/replace) and bulk delete.
 * @param props - Selection count, available tags, and action callbacks
 * @returns Bulk action bar component
 */
export function BulkActions({
  selectedCount,
  tags,
  onBulkTag,
  onBulkDelete,
  onDeselectAll,
}: BulkActionsProps) {
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleBulkTag = async (tagId: number) => {
    setLoading(true);
    try {
      await onBulkTag([tagId], 'add');
    } finally {
      setLoading(false);
      setShowTagPicker(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    try {
      await onBulkDelete();
    } finally {
      setLoading(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-lg border p-3">
      <span className="text-sm font-medium">{selectedCount} selected</span>

      <div className="relative">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => {
            setShowTagPicker(!showTagPicker);
            setConfirmDelete(false);
          }}
          disabled={loading}
        >
          Tag
        </Button>

        {showTagPicker && tags.length > 0 && (
          <div className="bg-popover border-border absolute top-full left-0 z-10 mt-1 min-w-[140px] rounded-md border p-2 shadow-md">
            {tags.map((tag) => (
              <Button
                key={tag.id}
                variant="ghost"
                onClick={() => handleBulkTag(tag.id)}
                className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-xs font-normal"
                disabled={loading}
              >
                {tag.color && (
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                )}
                {tag.name}
              </Button>
            ))}
          </div>
        )}
      </div>

      {confirmDelete ? (
        <div className="flex items-center gap-2">
          <span className="text-destructive text-xs">Delete {selectedCount} highlights?</span>
          <Button
            variant="destructive"
            size="sm"
            className="text-xs"
            onClick={handleDelete}
            disabled={loading}
          >
            Confirm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setConfirmDelete(false)}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive text-xs"
          onClick={() => {
            setConfirmDelete(true);
            setShowTagPicker(false);
          }}
          disabled={loading}
        >
          Delete
        </Button>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="ml-auto text-xs"
        onClick={onDeselectAll}
        disabled={loading}
      >
        Deselect all
      </Button>
    </div>
  );
}
