import { requireUser } from "../../lib/auth.js";
import * as userService from "./serviceUser.js";

export const userResolvers = {
  Query: {
    me: async (_parent, _args, context) => {
      const user = await requireUser(context);
      return userService.toPublicUser(user);
    },
  },
};
