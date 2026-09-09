import { onboardTeamSchema } from "@jobs/schema";
import { WelcomeEmail } from "@midday/email/emails/welcome";
import { render } from "@midday/email/render";
import { createClient } from "@midday/supabase/job";
import { getEmailFrom } from "@midday/utils/email-from";
import { getResend } from "@midday/utils/resend";
import { schemaTask } from "@trigger.dev/sdk";

export const onboardTeam = schemaTask({
  id: "onboard-team",
  schema: onboardTeamSchema,
  maxDuration: 300,
  run: async ({ userId }) => {
    const supabase = createClient();

    const { data: user, error } = await supabase
      .from("users")
      .select("id, full_name, email, team_id")
      .eq("id", userId)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    if (!user.full_name || !user.email) {
      throw new Error("User data is missing");
    }

    const [firstName, lastName] = user.full_name.split(" ") ?? [];

    const audienceId = process.env.RESEND_AUDIENCE_ID;

    if (audienceId) {
      await getResend().contacts.create({
        email: user.email,
        firstName,
        lastName,
        unsubscribed: false,
        audienceId,
      });
    }

    await getResend().emails.send({
      to: user.email,
      subject: "Welcome to Midday",
      from: getEmailFrom(),
      html: await render(
        WelcomeEmail({
          fullName: user.full_name,
        }),
      ),
    });
  },
});
