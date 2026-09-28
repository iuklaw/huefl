import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

type Choice = "tray" | "quit";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: Choice, remember: boolean) => void;
};

/** Asked when the window is closed and the user has not picked a default yet. */
export function CloseDialog({ open, onOpenChange, onChoose }: Props) {
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (open) setRemember(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("close.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("close.description")}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id="close-remember"
              checked={remember}
              onCheckedChange={(value) => setRemember(value === true)}
            />
            <Label htmlFor="close-remember">{t("close.remember")}</Label>
          </div>
          <p className="pl-6 text-xs text-muted-foreground">{t("close.remember_hint")}</p>
        </div>

        <AlertDialogFooter>
          <AlertDialogAction variant="outline" onClick={() => onChoose("quit", remember)}>
            {t("close.quit")}
          </AlertDialogAction>
          <AlertDialogAction autoFocus onClick={() => onChoose("tray", remember)}>
            {t("close.to_tray")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
