import {
  ACCOUNT_STATUSES,
  requireHouseAccess,
  requireOwnerMember,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  createHouseSchema,
  houseIdSchema,
  housesSchema,
  updateHouseSchema,
} from "./schemasHouse.js";
import * as houseService from "./serviceHouse.js";

export const houseResolvers = {
  Query: {
    houses: async (_parent, args, context) => {
      await requireOwnerMember(context, args.ownerAccountId, {
        statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_READ,
      });
      const input = validate(housesSchema, args);
      return houseService.listHouses(context, input);
    },

    house: async (_parent, args, context) => {
      const { house } = await requireHouseAccess(context, args.id, {
        statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_READ,
      });
      validate(houseIdSchema, args);
      return houseService.toPublicHouse(house);
    },
  },

  Mutation: {
    createHouse: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(
        context,
        args.input.ownerAccountId,
        { statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE },
      );
      const { input } = validate(createHouseSchema, args);
      return houseService.createHouse(context, { ...input, actorId: user.id });
    },

    updateHouse: async (_parent, args, context) => {
      const { user } = await requireHouseAccess(context, args.input.id, {
        statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE,
      });
      const { input } = validate(updateHouseSchema, args);
      return houseService.updateHouse(context, { ...input, actorId: user.id });
    },
  },
};
