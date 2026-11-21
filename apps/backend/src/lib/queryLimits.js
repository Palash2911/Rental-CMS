import { GraphQLError, Kind, parse, validate } from "graphql";

/** Largest /graphql request body accepted (Yoga answers 413 above it). */
export const MAX_REQUEST_BODY_BYTES = 100 * 1024;

/** Most lexical tokens a document may have; parsing stops past it, before any work. */
export const MAX_QUERY_TOKENS = 2000;

/**
 * Most root fields one operation may select, aliases and fragments included, so one request
 * cannot fan out into hundreds of guarded queries.
 */
export const MAX_ROOT_FIELDS = 20;

const INTROSPECTION_PREFIX = "__";

const MESSAGES = Object.freeze({
  TOO_MANY_ROOT_FIELDS: `An operation may select at most ${MAX_ROOT_FIELDS} root fields.`,
});

// Inline fragments and fragment spreads are followed, so they cannot hide extra root fields.
// Validation has not yet rejected fragment cycles when this rule runs, hence the visited set.
function countRootFields(selectionSet, context, visited) {
  let count = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      count += selection.name.value.startsWith(INTROSPECTION_PREFIX) ? 0 : 1;
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      count += countRootFields(selection.selectionSet, context, visited);
    } else if (!visited.has(selection.name.value)) {
      visited.add(selection.name.value);
      const fragment = context.getFragment(selection.name.value);
      count += fragment ? countRootFields(fragment.selectionSet, context, visited) : 0;
    }
  }

  return count;
}

/** Validation rule: each operation selects at most MAX_ROOT_FIELDS root fields. */
export function MaxRootFieldsRule(context) {
  return {
    OperationDefinition(node) {
      if (countRootFields(node.selectionSet, context, new Set()) > MAX_ROOT_FIELDS) {
        context.reportError(new GraphQLError(MESSAGES.TOO_MANY_ROOT_FIELDS, { nodes: node }));
      }
    },
  };
}

/**
 * Yoga plugin for the document limits: MAX_QUERY_TOKENS when parsing and MaxRootFieldsRule
 * when validating. With `hideSuggestions`, validation and execution errors leave out
 * "Did you mean …" hints, which would otherwise list schema names with introspection off.
 */
export function createQueryLimitsPlugin({ hideSuggestions }) {
  return {
    onParse({ setParseFn }) {
      setParseFn((source, options) => parse(source, { ...options, maxTokens: MAX_QUERY_TOKENS }));
    },

    onValidate({ addValidationRule, setValidationFn }) {
      addValidationRule(MaxRootFieldsRule);

      if (hideSuggestions) {
        // Envelop calls this with graphql 16's (schema, document, rules, typeInfo, options);
        // graphql 17's validate takes (schema, document, rules, options).
        setValidationFn((schema, documentAST, rules) =>
          validate(schema, documentAST, rules, { hideSuggestions: true }),
        );
      }
    },

    onExecute({ args }) {
      if (hideSuggestions) {
        args.hideSuggestions = true;
      }
    },
  };
}
