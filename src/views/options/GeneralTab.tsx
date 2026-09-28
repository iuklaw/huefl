import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { actions } from "@/core/app";
import { locale, t } from "@/i18n";
import type { CloseBehavior, Preferences, ThemePreference } from "@/types";
import { Section } from "./Section";

const CLOSE_OPTIONS: CloseBehavior[] = ["ask", "tray", "quit"];
const THEMES: ThemePreference[] = ["system", "dark", "light"];

export function GeneralTab({ preferences }: { preferences: Preferences }) {
  return (
    <div className="space-y-5">
      <Section title={t("general.close_title")}>
        <RadioGroup
          value={preferences.closeBehavior}
          onValueChange={(value) =>
            void actions.setPreferences({ closeBehavior: value as CloseBehavior })
          }
          className="gap-1"
        >
          {CLOSE_OPTIONS.map((option) => (
            <Label
              key={option}
              htmlFor={`close-${option}`}
              className="flex cursor-pointer items-center gap-3 rounded-md bg-card px-3 py-2.5 font-normal hover:bg-accent"
            >
              <RadioGroupItem id={`close-${option}`} value={option} />
              {t(`general.close.${option}`)}
            </Label>
          ))}
        </RadioGroup>
      </Section>

      <Separator />

      <Section title={t("general.theme")}>
        <Select
          value={preferences.theme}
          onValueChange={(value) => void actions.setPreferences({ theme: value as ThemePreference })}
        >
          <SelectTrigger className="w-full" aria-label={t("general.theme")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((theme) => (
              <SelectItem key={theme} value={theme}>
                {t(`general.theme.${theme}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Section>

      <Section title={t("general.language")} description={t("general.language_hint")}>
        <Select value={locale}>
          <SelectTrigger className="w-full" aria-label={t("general.language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">{t("general.language.en")}</SelectItem>
          </SelectContent>
        </Select>
      </Section>
    </div>
  );
}
