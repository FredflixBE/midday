import { getAppUrl } from "@midday/utils/envs";
import { Hr, Link, Section, Text } from "@react-email/components";
import { LogoFooter } from "./logo-footer";
import { getEmailInlineStyles, getEmailThemeClasses } from "./theme";

export function Footer() {
  const appUrl = getAppUrl();
  const themeClasses = getEmailThemeClasses();
  const lightStyles = getEmailInlineStyles("light");

  return (
    <Section className="w-full">
      <Hr
        className={themeClasses.border}
        style={{ borderColor: lightStyles.container.borderColor }}
      />

      <Text
        className={`font-serif text-[21px] font-normal mt-[40px] mb-[40px] ${themeClasses.text}`}
        style={{ color: lightStyles.text.color }}
      >
        Run your business smarter.
      </Text>

      <Text
        className={`text-[13px] leading-relaxed ${themeClasses.mutedText}`}
        style={{ color: lightStyles.mutedText.color }}
      >
        <Link
          href={appUrl}
          className={themeClasses.mutedLink}
          style={{ color: lightStyles.mutedText.color }}
        >
          Dashboard
        </Link>
        {" · "}
        <Link
          href={`${appUrl}/settings/notifications`}
          className={themeClasses.mutedLink}
          style={{ color: lightStyles.mutedText.color }}
        >
          Notifications
        </Link>
      </Text>

      <LogoFooter />
    </Section>
  );
}
