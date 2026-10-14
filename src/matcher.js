export function noteFieldValue(note, field) {
  const text = stringValue(note.text);
  const cw = stringValue(note.cw);
  const username = stringValue(note.user?.username);
  const filenames = Array.isArray(note.files)
    ? note.files.flatMap((file) => [stringValue(file?.name), stringValue(file?.comment)]).filter(Boolean)
    : [];
  const pollChoices = Array.isArray(note.poll?.choices)
    ? note.poll.choices.map((choice) => stringValue(choice?.text)).filter(Boolean)
    : [];

  switch (field) {
    case "text":
      return text;
    case "cw":
      return cw;
    case "username":
      return username;
    case "filename":
      return filenames.join("\n");
    case "content":
      return [text, cw, ...filenames, ...pollChoices].filter(Boolean).join("\n");
    default:
      return "";
  }
}

export function findMatchingRules(note, rules, selfUserId) {
  if (!isLocalUserNote(note) || note.userId === selfUserId || note.user?.id === selfUserId) return [];

  const normalizedUsername = stringValue(note.user?.username)
    .replace(/^@/u, "")
    .toLocaleLowerCase("en-US");

  return rules.filter((rule) => {
    const excludedUsers = rule.excludedUsers.map((username) =>
      stringValue(username).replace(/^@/u, "").toLocaleLowerCase("en-US"),
    );
    if (!rule.enabled || excludedUsers.includes(normalizedUsername)) return false;
    const target = noteFieldValue(note, rule.field);
    if (!target) return false;
    return rule.matchers.some((matcher) => matches(target, matcher));
  });
}

function matches(target, matcher) {
  if (matcher.type === "contains") {
    return target.toLocaleLowerCase("en-US").includes(matcher.value.toLocaleLowerCase("en-US"));
  }

  const expression = new RegExp(matcher.source, matcher.flags);
  return expression.test(target);
}

function isLocalUserNote(note) {
  return Boolean(note?.id && note?.user && note.user.host == null);
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
