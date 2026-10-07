import { TEMPLATES } from '@/lib/content-templates';
import { Button } from '@/components/ui/button';
import type { TemplateId } from '@/types';

interface TemplatePickerStepProps {
  onSelect: (id: TemplateId) => void;
}

export function TemplatePickerStep({ onSelect }: TemplatePickerStepProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-3" data-testid="template-picker">
      {Object.values(TEMPLATES).map((template) => {
        const { min, max } = template.targetLength;
        return (
          <Button
            key={template.id}
            type="button"
            variant="outline"
            onClick={() => onSelect(template.id)}
            className="bg-card hover:bg-card hover:border-primary h-auto flex-col items-start gap-2 p-4 whitespace-normal"
            data-testid={`template-card-${template.id}`}
          >
            <span className="text-foreground text-sm font-medium">{template.name}</span>
            <span className="text-muted-foreground text-xs leading-snug">
              {template.description}
            </span>
            <span className="text-muted-foreground mt-auto text-xs">
              {min.toLocaleString()}–{max.toLocaleString()} words
            </span>
          </Button>
        );
      })}
    </div>
  );
}
