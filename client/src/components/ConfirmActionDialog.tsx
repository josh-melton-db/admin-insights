import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@databricks/appkit-ui/react';
import type { MutationPreview } from '../../../shared/admin-insights';

export function ConfirmActionDialog({
  open,
  onOpenChange,
  preview,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: MutationPreview | null;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm reversible admin action</AlertDialogTitle>
          <AlertDialogDescription>
            {preview
              ? `${preview.action} on ${preview.targetType} ${preview.targetName} runs as the signed-in user. Mode: ${preview.mode}. Review the before/after payload, then confirm.`
              : 'Preview the mutation before applying it.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs text-foreground">
            {JSON.stringify({ before: preview.before, after: preview.after }, null, 2)}
          </pre>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending || !preview}>
            {preview?.mode === 'dry_run' ? 'Record dry run' : 'Apply change'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
