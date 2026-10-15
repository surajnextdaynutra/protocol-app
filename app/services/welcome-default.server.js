/* Built-in welcome email - the same template the Settings tab held for the
   Shopify Customer Sync Apps Script. Used whenever WELCOME_EMAIL_SUBJECT /
   WELCOME_EMAIL_BODY are left empty, and by "Reset to default". */

export const WELCOME_DEFAULT_SUBJECT = "Your Protocol Therapeutics Account Is Ready";

export const WELCOME_DEFAULT_BODY = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Welcome to Protocol Therapeutics</title>
  <!--[if mso]>
  <style>table,td,a{font-family:Arial,Helvetica,sans-serif !important;}</style>
  <![endif]-->
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
    img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
    body{margin:0 !important;padding:0 !important;width:100% !important;}
    a{color:#1f2d3d;}
    @media only screen and (max-width:620px){
      .pt-container{width:100% !important;}
      .pt-pad{padding-left:24px !important;padding-right:24px !important;}
    }
  </style>
</head>

<body style="margin:0;padding:0;background:#f4f6f8;">

  <!-- Preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f6f8;">
    Your Protocol Therapeutics account is active. Log in to get started.
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6f8;">
    <tr>
      <td align="center" style="padding:40px 15px;">

        <table role="presentation" class="pt-container" cellpadding="0" cellspacing="0" border="0" width="600"
               style="width:600px;max-width:600px;background:#ffffff;border-radius:8px;">

          <!-- Logo -->
          <tr>
            <td align="center" class="pt-pad" style="padding:35px 30px 20px;">
              <img src="https://cdn.shopify.com/s/files/1/0781/6347/6651/files/Protocol_Therapeutics_logo.webp?v=1783570590"
                   alt="Protocol Therapeutics" width="180"
                   style="display:block;width:180px;max-width:180px;height:auto;" />
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td class="pt-pad" style="padding:10px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:26px;color:#333333;">
              Hi <strong>[First Name] [Last Name]</strong>,
            </td>
          </tr>

          <!-- Message -->
          <tr>
            <td class="pt-pad" style="padding:20px 40px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:26px;color:#555555;">
              <strong>Welcome to Protocol Therapeutics.</strong><br /><br />
              Your account has been activated and is ready to use.<br /><br />
              Log in to complete any required next steps and access helpful resources.
            </td>
          </tr>

          <!-- Button -->
          <tr>
            <td align="center" class="pt-pad" style="padding:0 40px 30px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                           href="[link]" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="14%" fillcolor="#1f2d3d" strokecolor="#1f2d3d">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;">Click Here to Get Started</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="[link]" target="_blank"
                 style="display:inline-block;background:#1f2d3d;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;line-height:20px;padding:12px 40px;border-radius:6px;">
                Click Here to Get Started
              </a>
              <!--<![endif]-->
            </td>
          </tr>

          <!-- Support line -->
          <tr>
            <td class="pt-pad" style="padding:0 40px 8px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:26px;color:#555555;">
              If you have any questions, our team is here to help.
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td class="pt-pad" style="padding:30px 40px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr><td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="pt-pad" style="padding:0 40px 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#777777;">
              The Protocol Therapeutics Support Team
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
`;
