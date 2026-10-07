'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface PasswordConfirmDialogProps {
  open: boolean;
  onConfirm: (password: string) => void;
  onCancel: () => void;
  title?: string;
  description?: string;
  loading?: boolean;
  error?: string | null;
}

/**
 * Dialog that prompts for password confirmation before saving encrypted settings.
 */
export function PasswordConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title = 'Confirm Password',
  description = 'Enter your password to save encrypted settings.',
  loading = false,
  error = null,
}: PasswordConfirmDialogProps) {
  const [password, setPassword] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password) onConfirm(password);
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) {
      setPassword('');
      onCancel();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              data-testid="confirm-password-input"
            />
            {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || loading}>
              {loading ? 'Saving...' : 'Confirm'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
