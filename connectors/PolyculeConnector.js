define(["jquery", "underscore"], function ($, _) {
  "use strict";

  function PolyculeConnector(params) {
	this.params = params || {};

	this.data = null;

	this.nodes = {};
	this.relationships = {};

	this.load = function (callback) {
	  var self = this;

	  $.getJSON(this.params.url)
	  .done(function (data) {
		self.data = data;

		self.buildNodes();
		self.buildRelationships();

		if (callback) {
		  callback(null, self);
		}
	  })
	  .fail(function (xhr, status, error) {
		if (callback) {
		  callback(error || new Error("Unable to load polycule data"));
		}
	  });
	};

	/*
	 * Convert people into BGPlay-style nodes.
	 */
	this.buildNodes = function () {
	  this.nodes = {};

	  this.data.people.forEach(function (person) {
		this.nodes[person.id] = {
		  id: person.id,
		  name: person.name,

		  /*
		   * BGPlay normally has network-specific
		   * attributes here. We can attach anything
		   * useful to the person.
		   */
		  type: "person",
		};
	  }, this);
	};

	/*
	 * Convert relationships into BGPlay-style paths.
	 */
	this.buildRelationships = function () {
	  this.relationships = {};

	  this.data.relationships.forEach(function (relationship) {
		this.relationships[relationship.id] = {
		  id: relationship.id,

		  source: relationship.source,

		  target: relationship.target,

		  type: relationship.type,

		  start: relationship.start,

		  end: relationship.end || null,
		};
	  }, this);
	};

	/*
	 * Return all people.
	 */
	this.getNodes = function () {
	  return this.nodes;
	};

	/*
	 * Return all relationships.
	 */
	this.getRelationships = function () {
	  return this.relationships;
	};

	/*
	 * Return a relationship by ID.
	 */
	this.getRelationship = function (id) {
	  return this.relationships[id];
	};

	/*
	 * Return the initial state at a particular time.
	 */
	this.getInitialState = function (timestamp) {
	  var active = [];

	  Object.keys(this.relationships).forEach(function (id) {
		var relationship = this.relationships[id];

		var started = relationship.start <= timestamp;

		var ended = relationship.end !== null && relationship.end <= timestamp;

		if (started && !ended) {
		  active.push(relationship);
		}
	  }, this);

	  return active;
	};

	/*
	 * Generate relationship events.
	 */
	this.getEvents = function () {
	  var events = [];

	  Object.keys(this.relationships).forEach(function (id) {
		var relationship = this.relationships[id];

		events.push({
		  id: relationship.id + "-start",
		  timestamp: relationship.start,
		  type: "relationship-start",
		  relationship: relationship,
		});

		if (relationship.end !== null) {
		  events.push({
			id: relationship.id + "-end",
			timestamp: relationship.end,
			type: "relationship-end",
			relationship: relationship,
		  });
		}
	  }, this);

	  return events.sort(function (a, b) {
		return a.timestamp - b.timestamp;
	  });
	};

	/*
	 * Convert polycule data into a BGPlay dump so the
	 * existing graph/timeline can render people as nodes
	 * and relationships as announced paths.
	 */
	this.toBgplayDump = function () {
	  var start = this.data.starttime;
	  var end = this.data.endtime;
	  var usedLabels = {};
	  var idToLabel = {};
	  var nodes = [];
	  var sourceIds = {};
	  var targetPrefixes = {};
	  var initial_state = [];
	  var events = [];

	  this.data.people.forEach(function (person) {
		var label = person.name || person.id;

		if (usedLabels[label]) {
		  label = label + " (" + person.id + ")";
		}

		usedLabels[label] = true;
		idToLabel[person.id] = label;

		nodes.push({
		  as_number: label,
		  owner: person.name || person.id,
		});
	  });

	  this.data.relationships.forEach(function (relationship) {
		var sourceLabel = idToLabel[relationship.source];
		var targetLabel = idToLabel[relationship.target];
		var path = [sourceLabel, targetLabel];
		var sourceId = relationship.source;
		var targetPrefix = targetLabel;

		sourceIds[sourceId] = sourceLabel;
		targetPrefixes[relationship.target] = targetLabel;

		if (relationship.start <= start) {
		  initial_state.push({
			source_id: sourceId,
			target_prefix: targetPrefix,
			path: path,
		  });
		} else {
		  events.push({
			timestamp: relationship.start,
			type: "A",
			attrs: {
			  source_id: sourceId,
			  target_prefix: targetPrefix,
			  path: path,
			},
		  });
		}

		if (relationship.end != null && relationship.end <= end) {
		  events.push({
			timestamp: relationship.end,
			type: "W",
			attrs: {
			  source_id: sourceId,
			  target_prefix: targetPrefix,
			},
		  });
		}
	  });

	  events.sort(function (a, b) {
		return a.timestamp - b.timestamp;
	  });

	  return {
		query_starttime: start,
		query_endtime: end,
		resource: "polycule",
		nodes: nodes,
		sources: Object.keys(sourceIds).map(function (id) {
		  return {
			id: id,
			as_number: sourceIds[id],
		  };
		}),
		targets: Object.keys(targetPrefixes).map(function (id) {
		  return {
			prefix: targetPrefixes[id],
		  };
		}),
		initial_state: initial_state,
		events: events,
	  };
	};
  }

  return PolyculeConnector;
});