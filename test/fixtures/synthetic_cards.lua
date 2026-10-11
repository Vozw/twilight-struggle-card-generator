-- Synthetic card table for the importer tests.
--
-- Every card here is invented. The layout mirrors the shape of the real Steam
-- client table (one table-assignment block per card, closed by a brace in
-- column 0, with tab-indented contents) so the parser is exercised against
-- realistic structure, without any of GMT's actual card data.
--
-- Keep this comment free of the literal assignment syntax: the importer's
-- pattern is not Lua-aware and would read it as a card.

g_twilight_cards["Plain Event"] = {
	card_name = "Plain Event";
	card_type = "Event";
	stage = "Early War";

	card_number = 3;

	operations_points = 2;

	event_owner = "USSR";
	event_effects = {
		{ "GainVictoryPoints", 1 },
	};
	event_text = "Gain 1 VP.";
	remove_if_used_as_event = true;
}

g_twilight_cards["Permanent Event"] = {
	card_name = "Permanent Event";
	card_type = "Event";
	stage = "Mid War";

	card_number = 1;

	operations_points = 4;

	event_owner = "USA";
	event_effects = {
		{ "PutThisCardInPlay", 0 },
	};
	event_text = "*Play after \"Plain Event\".*\n" ..
				"Something lasts forever.";
	remove_if_used_as_event = true;
}

g_twilight_cards["Turn Long Event"] = {
	card_name = "Turn Long Event";
	card_type = "Event";
	stage = "Mid War";

	card_number = 2;

	operations_points = 3;

	event_owner = "USSR";
	event_effects = {
		{ "PutThisCardInPlay", 1 },
	};
	triggered_effects = {
		{
			conditions = {
				{ "AtEndOfTurn", 0 },
			};
			triggereffect = {
				{ "TriggerRemoveThisCardFromPlay", 1 },
			};
		},
	};
	event_text = "Something lasts until the end of the turn.";
}

g_twilight_cards["Conditional Permanent"] = {
	card_name = "Conditional Permanent";
	card_type = "Event";
	stage = "Late War";

	card_number = 4;

	operations_points = 3;

	event_owner = "USSR";
	event_effects = {
		{ "AddInfluenceInEuropeMax2", 4 },
		{ "PutThisCardInPlay", 0, condition={"IfSomethingIsNotInRemovedPile",0} },
	};
	event_text = "Regression case: a trailing condition inside the braces.";
}

g_twilight_cards["Special Event"] = {
	card_name = "Special Event";
	card_type = "Event";
	stage = "Mid War";

	card_number = 5;

	operations_points = 3;

	event_owner = "USA";
	event_effects = {
		{ "PutThisCardInPlaySpecial", 0 },
	};
	event_text = "Stays in play until something cancels it.";
}

g_twilight_cards["Region Choice Event"] = {
	card_name = "Region Choice Event";
	card_type = "Event";
	stage = "Late War";

	card_number = 6;

	operations_points = 3;

	event_owner = "USA";
	event_effects = {
		{ "ChooseOneRegion", 0 },
		{ "PutThisCardInPlayWithRegionChoice", 0 },
	};
	event_text = "Clears at the end of the turn despite the zero argument.";
}

g_twilight_cards["Quagmire"] = {
	card_name = "Quagmire";
	card_type = "Event";
	stage = "Mid War";

	card_number = 7;

	operations_points = 3;

	event_owner = "USSR";
	event_effects = {
		{ "SomeBespokeOpcode", 0 },
	};
	event_text = "Named after a real card whose lasting effect has no structural marker.";
}

g_twilight_cards["Test Region Scoring"] = {
	card_name = "Test Region Scoring";
	card_type = "Scoring";
	stage = "Early War";

	card_number = 8;

	scoring_region = "Asia";
	may_be_held = false;
	event_text = "Both sides score:\nPresence: 3\nDomination: 7\nControl: 9";
}

g_twilight_cards["Optional Neutral"] = {
	card_name = "Optional Neutral";
	card_type = "Event";
	stage = "Late War";

	card_number = 9;

	operations_points = 1;

	optional_card = true;
	event_owner = "Neutral";
	event_text = "An optional card.";
}
